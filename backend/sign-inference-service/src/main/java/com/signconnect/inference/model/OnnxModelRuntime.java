package com.signconnect.inference.model;

import ai.onnxruntime.NodeInfo;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.inference.api.PredictionRequest;
import com.signconnect.inference.api.PredictionResponse;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantReadWriteLock;

@Component
public class OnnxModelRuntime implements AutoCloseable {

    private static final Logger LOGGER = LoggerFactory.getLogger(OnnxModelRuntime.class);
    private static final long[] INPUT_SHAPE = {1, 30, 224};
    private static final double PROBABILITY_SUM_TOLERANCE = 1.0e-4;
    private static final String BUNDLED_SYNTHETIC_SHA256 =
            "fd2cf50b2bdbe8c7c6953e0f809b33df2012de2a476b09fcff0e6987e289c4a8";

    private final ResourceLoader resourceLoader;
    private final ObjectMapper objectMapper;
    private final String modelResource;
    private final String labelsResource;
    private final String inputName;
    private final String outputName;
    private final String expectedModelVersion;
    private final NanoTimeSource nanoTimeSource;
    private final InferenceConcurrencyLimiter concurrencyLimiter;
    private final boolean mockModelAllowed;
    private final boolean developmentModelAllowed;
    private final AtomicBoolean initializationAttempted = new AtomicBoolean();
    private final AtomicBoolean shutdown = new AtomicBoolean();
    private final AtomicInteger initializationCount = new AtomicInteger();
    private final AtomicInteger shutdownCount = new AtomicInteger();
    private final AtomicInteger sessionCloseCount = new AtomicInteger();
    private final AtomicInteger environmentCloseCount = new AtomicInteger();
    private final AtomicInteger outstandingInvocationResources = new AtomicInteger();
    private final AtomicLong predictionCount = new AtomicLong();
    private final ReentrantReadWriteLock lifecycleLock = new ReentrantReadWriteLock();

    private volatile OrtEnvironment environment;
    private volatile OrtSession session;
    private volatile ModelContract contract;
    private volatile boolean ready;

    @FunctionalInterface
    public interface NanoTimeSource {
        long nanoTime();
    }

    @Autowired
    public OnnxModelRuntime(
            ResourceLoader resourceLoader,
            ObjectMapper objectMapper,
            @Value("${signconnect.inference.model.resource:}") String modelResource,
            @Value("${signconnect.inference.model.labels-resource:}") String labelsResource,
            @Value("${signconnect.inference.model.input-name:features}") String inputName,
            @Value("${signconnect.inference.model.output-name:probabilities}") String outputName,
            @Value("${signconnect.inference.model.expected-version:}") String expectedModelVersion,
            @Value("${signconnect.inference.model.allow-mock-model:false}") boolean allowMockModel,
            Environment environment,
            InferenceConcurrencyLimiter concurrencyLimiter) {
        this(resourceLoader, objectMapper, modelResource, labelsResource, inputName, outputName,
                expectedModelVersion,
                System::nanoTime, concurrencyLimiter,
                allowMockModel && isDevelopmentProfile(environment),
                isDevelopmentProfile(environment));
    }

    OnnxModelRuntime(
            ResourceLoader resourceLoader,
            ObjectMapper objectMapper,
            String modelResource,
            String labelsResource,
            String inputName,
            String outputName,
            NanoTimeSource nanoTimeSource,
            InferenceConcurrencyLimiter concurrencyLimiter) {
        this(resourceLoader, objectMapper, modelResource, labelsResource, inputName, outputName,
                "synthetic-v1", nanoTimeSource, concurrencyLimiter, true, true);
    }

    OnnxModelRuntime(
            ResourceLoader resourceLoader,
            ObjectMapper objectMapper,
            String modelResource,
            String labelsResource,
            String inputName,
            String outputName,
            String expectedModelVersion,
            NanoTimeSource nanoTimeSource,
            InferenceConcurrencyLimiter concurrencyLimiter,
            boolean mockModelAllowed,
            boolean developmentModelAllowed) {
        this.resourceLoader = resourceLoader;
        this.objectMapper = objectMapper;
        this.modelResource = modelResource;
        this.labelsResource = labelsResource;
        this.inputName = inputName;
        this.outputName = outputName;
        this.expectedModelVersion = expectedModelVersion;
        this.nanoTimeSource = nanoTimeSource;
        this.concurrencyLimiter = concurrencyLimiter;
        this.mockModelAllowed = mockModelAllowed;
        this.developmentModelAllowed = developmentModelAllowed;
    }

    @PostConstruct
    void initialize() {
        if (!initializationAttempted.compareAndSet(false, true)) {
            return;
        }
        initializationCount.incrementAndGet();

        lifecycleLock.writeLock().lock();
        OrtEnvironment candidateEnvironment = null;
        OrtSession candidateSession = null;
        try {
            if (isBlank(modelResource) || isBlank(labelsResource)) {
                LOGGER.info("Inference model is not configured; readiness is unavailable");
                return;
            }

            Resource labelMap = readableResource(labelsResource);
            ModelContract candidateContract;
            try (InputStream input = labelMap.getInputStream()) {
                candidateContract = ModelContract.read(objectMapper, input);
            }
            if (isBlank(expectedModelVersion)
                    || !expectedModelVersion.equals(candidateContract.modelVersion())) {
                throw new IllegalArgumentException(
                        "Selected model version does not match the model metadata");
            }
            if (candidateContract.mockModel() && !mockModelAllowed) {
                throw new IllegalArgumentException(
                        "Synthetic model is not permitted outside an explicit development/test gate");
            }
            if (!developmentModelAllowed && !candidateContract.isProductionReady()) {
                throw new IllegalArgumentException(
                        "Model metadata is not approved for production readiness");
            }
            if (!inputName.equals(candidateContract.input().name())
                    || !outputName.equals(candidateContract.output().name())) {
                throw new IllegalArgumentException(
                        "Configured tensor names do not match the model metadata");
            }

            byte[] modelBytes;
            Resource model = readableResource(modelResource);
            String metadataArtifactName = candidateContract.onnx().artifactPath()
                    .substring(candidateContract.onnx().artifactPath().lastIndexOf('/') + 1);
            if (!metadataArtifactName.equals(model.getFilename())) {
                throw new IllegalArgumentException(
                        "Configured model resource does not match the metadata artifact path");
            }
            try (InputStream input = model.getInputStream()) {
                modelBytes = input.readAllBytes();
            }
            if (modelBytes.length == 0) {
                throw new IllegalArgumentException("Model artifact is empty");
            }
            String artifactSha256 = HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(modelBytes));
            if (!artifactSha256.equals(candidateContract.artifactSha256())) {
                throw new IllegalArgumentException("Model artifact does not match its metadata");
            }
            if (BUNDLED_SYNTHETIC_SHA256.equals(artifactSha256)
                    && !candidateContract.mockModel()) {
                throw new IllegalArgumentException(
                        "Bundled synthetic artifact must retain its mock-model marker");
            }

            candidateEnvironment = OrtEnvironment.getEnvironment("signconnect-inference");
            if (!candidateContract.runtime().isSatisfiedBy(candidateEnvironment.getVersion())) {
                throw new IllegalArgumentException(
                        "Installed ONNX Runtime does not satisfy the model metadata");
            }
            try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                options.addCPU(true);
                options.setDeterministicCompute(true);
                candidateSession = candidateEnvironment.createSession(modelBytes, options);
            }
            validateSessionContract(candidateSession, candidateContract);

            environment = candidateEnvironment;
            session = candidateSession;
            contract = candidateContract;
            ready = true;
            LOGGER.info("Inference model ready: mode={}, labels={}", modelMode(),
                    candidateContract.labels().size());
        } catch (Exception | LinkageError failure) {
            ready = false;
            closeSession(candidateSession);
            closeEnvironment(candidateEnvironment);
            LOGGER.debug("Inference model initialization detail", failure);
            LOGGER.warn("Inference model initialization failed; readiness is unavailable");
        } finally {
            lifecycleLock.writeLock().unlock();
        }
    }

    public PredictionResponse predict(PredictionRequest request) {
        if (request == null || !request.hasValidInferenceContract()) {
            throw new IllegalArgumentException("Request does not match inference contract");
        }
        if (!ready) {
            throw new ModelUnavailableException();
        }

        try (InferenceConcurrencyLimiter.Lease ignored = concurrencyLimiter.acquire()) {
            lifecycleLock.readLock().lock();
            try {
                OrtEnvironment activeEnvironment = environment;
                OrtSession activeSession = session;
                ModelContract activeContract = contract;
                if (!ready || activeEnvironment == null || activeSession == null || activeContract == null) {
                    throw new ModelUnavailableException();
                }

                long startedAt = nanoTimeSource.nanoTime();
                float[] values = request.toFloatTensor();
                float[] probabilities;
                OnnxTensor tensor = OnnxTensor.createTensor(
                        activeEnvironment,
                        FloatBuffer.wrap(values),
                        INPUT_SHAPE);
                outstandingInvocationResources.incrementAndGet();
                try (tensor) {
                    OrtSession.Result result = activeSession.run(Map.of(inputName, tensor));
                    outstandingInvocationResources.incrementAndGet();
                    try (result) {
                        probabilities = readProbabilities(result, activeContract.labels().size());
                    } finally {
                        outstandingInvocationResources.decrementAndGet();
                    }
                } finally {
                    outstandingInvocationResources.decrementAndGet();
                }

                int labelIndex = highestProbabilityIndex(probabilities);
                ModelContract.Label label = activeContract.labelAt(labelIndex);
                CanonicalModelDecision decision = CanonicalModelDecision.from(
                        label,
                        probabilities[labelIndex],
                        activeContract.decision().minimumConfidence());
                long elapsedNanos = Math.max(0L, nanoTimeSource.nanoTime() - startedAt);
                predictionCount.incrementAndGet();
                return new PredictionResponse(
                        1,
                        request.requestId(),
                        request.streamId(),
                        request.windowSequence(),
                        decision.wireLabelId(),
                        decision.wireCaptionText(),
                        decision.confidence(),
                        activeContract.modelVersion(),
                        elapsedNanos / 1_000_000.0,
                        activeContract.mockModel());
            } catch (OrtException | IllegalStateException failure) {
                ready = false;
                LOGGER.error("Inference execution failed; model readiness is unavailable");
                throw new ModelUnavailableException();
            } finally {
                lifecycleLock.readLock().unlock();
            }
        }
    }

    public boolean isReady() {
        return ready;
    }

    public String modelMode() {
        ModelContract activeContract = contract;
        if (!ready || activeContract == null) {
            return "unavailable";
        }
        return activeContract.mockModel() ? "synthetic" : "onnx";
    }

    int initializationCount() {
        return initializationCount.get();
    }

    int shutdownCount() {
        return shutdownCount.get();
    }

    int sessionCloseCount() {
        return sessionCloseCount.get();
    }

    int environmentCloseCount() {
        return environmentCloseCount.get();
    }

    int outstandingInvocationResources() {
        return outstandingInvocationResources.get();
    }

    OrtEnvironment environment() {
        return environment;
    }

    OrtSession session() {
        return session;
    }

    public long predictionCount() {
        return predictionCount.get();
    }

    @PreDestroy
    @Override
    public void close() {
        if (!shutdown.compareAndSet(false, true)) {
            return;
        }
        shutdownCount.incrementAndGet();
        lifecycleLock.writeLock().lock();
        try {
            ready = false;
            OrtSession activeSession = session;
            OrtEnvironment activeEnvironment = environment;
            session = null;
            environment = null;
            contract = null;
            closeSession(activeSession);
            closeEnvironment(activeEnvironment);
        } finally {
            lifecycleLock.writeLock().unlock();
        }
    }

    private Resource readableResource(String location) throws IOException {
        Resource resource = resourceLoader.getResource(location);
        if (!resource.exists() || !resource.isReadable()) {
            throw new IOException("Configured model resource is unavailable");
        }
        return resource;
    }

    private void validateSessionContract(OrtSession candidateSession, ModelContract candidateContract)
            throws OrtException {
        Map<String, NodeInfo> inputs = candidateSession.getInputInfo();
        NodeInfo input = inputs.get(inputName);
        if (input == null || !(input.getInfo() instanceof TensorInfo inputTensor)
                || inputTensor.type != OnnxJavaType.FLOAT
                || !Arrays.equals(inputTensor.getShape(), INPUT_SHAPE)) {
            throw new IllegalArgumentException("Model input does not match the inference contract");
        }

        Map<String, NodeInfo> outputs = candidateSession.getOutputInfo();
        NodeInfo output = outputs.get(outputName);
        if (output == null || !(output.getInfo() instanceof TensorInfo outputTensor)
                || outputTensor.type != OnnxJavaType.FLOAT) {
            throw new IllegalArgumentException("Model output does not match the inference contract");
        }
        long[] outputShape = outputTensor.getShape();
        if (outputShape.length != 2 || outputShape[0] != 1
                || outputShape[1] != candidateContract.labels().size()) {
            throw new IllegalArgumentException("Model output does not match the label map");
        }
    }

    private float[] readProbabilities(OrtSession.Result result, int labelCount) throws OrtException {
        OnnxValue value = result.get(outputName)
                .orElseThrow(() -> new IllegalStateException("Configured model output is missing"));
        Object output = value.getValue();
        if (!(output instanceof float[][] rows) || rows.length != 1 || rows[0].length != labelCount) {
            throw new IllegalStateException("Model output does not match the label map");
        }
        return validateProbabilityVector(rows[0]);
    }

    static float[] validateProbabilityVector(float[] probabilities) {
        double probabilitySum = 0.0;
        for (float probability : probabilities) {
            if (!Float.isFinite(probability) || probability < 0.0f || probability > 1.0f) {
                throw new IllegalStateException("Model output is not a probability vector");
            }
            probabilitySum += probability;
        }
        if (Math.abs(probabilitySum - 1.0) > PROBABILITY_SUM_TOLERANCE) {
            throw new IllegalStateException("Model output is not a normalized probability vector");
        }
        return probabilities;
    }

    private static int highestProbabilityIndex(float[] probabilities) {
        int selected = 0;
        for (int index = 1; index < probabilities.length; index++) {
            if (probabilities[index] > probabilities[selected]) {
                selected = index;
            }
        }
        return selected;
    }

    private void closeSession(OrtSession value) {
        if (value == null) {
            return;
        }
        try {
            value.close();
        } catch (OrtException ignored) {
            LOGGER.warn("Inference session shutdown was incomplete");
        } finally {
            sessionCloseCount.incrementAndGet();
        }
    }

    private void closeEnvironment(OrtEnvironment value) {
        if (value == null) {
            return;
        }
        value.close();
        environmentCloseCount.incrementAndGet();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static boolean isDevelopmentProfile(Environment environment) {
        return environment.acceptsProfiles(Profiles.of("local", "development", "test"));
    }

    public static final class ModelUnavailableException extends RuntimeException {

        private final CanonicalModelDecision.Outcome outcome;

        public ModelUnavailableException() {
            super("Inference model is not ready");
            this.outcome = CanonicalModelDecision.unavailable().outcome();
        }

        public CanonicalModelDecision.Outcome outcome() {
            return outcome;
        }
    }
}
