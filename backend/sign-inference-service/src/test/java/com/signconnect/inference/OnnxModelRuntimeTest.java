package com.signconnect.inference.model;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.signconnect.inference.SignInferenceServiceApplication;
import com.signconnect.inference.api.PredictionRequest;
import com.signconnect.inference.api.PredictionResponse;
import com.signconnect.inference.config.InferenceLimitsProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.io.DefaultResourceLoader;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class OnnxModelRuntimeTest {

    private static final String MODEL_RESOURCE = "classpath:models/deterministic-sign-v1.onnx";
    private static final String LABEL_RESOURCE = "classpath:models/deterministic-sign-v1-labels.json";

    @TempDir
    Path temporaryDirectory;

    @Test
    void reusesOneRealOrtEnvironmentAndSessionForSequentialAndConcurrentPredictions() throws Exception {
        try (ConfigurableApplicationContext context = localContext()) {
            OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
            PredictionRequest active = fixture(context, "inference-request-active.valid.json");
            PredictionRequest idle = fixture(context, "inference-request-idle.valid.json");

            assertThat(runtime.isReady()).isTrue();
            assertThat(runtime.initializationCount()).isOne();
            assertThat(runtime.environment()).isInstanceOf(OrtEnvironment.class);
            assertThat(runtime.session()).isInstanceOf(OrtSession.class);

            OrtEnvironment environment = runtime.environment();
            OrtSession session = runtime.session();
            assertPrediction(runtime.predict(active), "MOCK_ACTIVE", true);
            assertPrediction(runtime.predict(idle), "NO_SIGN", true);

            List<Callable<PredictionResponse>> work = new ArrayList<>();
            for (int index = 0; index < 16; index++) {
                work.add(() -> runtime.predict(active));
            }
            try (ExecutorService executor = Executors.newFixedThreadPool(8)) {
                List<Future<PredictionResponse>> futures = executor.invokeAll(work);
                for (Future<PredictionResponse> future : futures) {
                    assertPrediction(future.get(), "MOCK_ACTIVE", true);
                }
            }

            assertThat(runtime.environment()).isSameAs(environment);
            assertThat(runtime.session()).isSameAs(session);
            assertThat(runtime.initializationCount()).isOne();
            assertThat(runtime.outstandingInvocationResources()).isZero();
        }
    }

    @Test
    void usesInjectedMonotonicTimeForDeterministicLatency() throws Exception {
        AtomicLong time = new AtomicLong(1_000_000_000L);
        OnnxModelRuntime runtime = new OnnxModelRuntime(
                new DefaultResourceLoader(),
                new ObjectMapper(),
                MODEL_RESOURCE,
                LABEL_RESOURCE,
                "features",
                "probabilities",
                () -> time.getAndAdd(3_500_000L),
                new InferenceConcurrencyLimiter(
                        new InferenceLimitsProperties(262_144, 4, 250L)));
        runtime.initialize();

        try {
            PredictionResponse response = runtime.predict(fixture(new ObjectMapper(), "inference-request-active.valid.json"));
            assertThat(response.inferenceLatencyMs()).isEqualTo(3.5);
        } finally {
            runtime.close();
        }
    }

    @Test
    void defaultProfileFailsClosedWithoutSelectingSyntheticResources() throws Exception {
        try (ConfigurableApplicationContext context = context()) {
            OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);

            assertThat(runtime.isReady()).isFalse();
            assertThat(runtime.modelMode()).isEqualTo("unavailable");
            assertThatThrownBy(() -> runtime.predict(fixture(context, "inference-request-active.valid.json")))
                    .isInstanceOf(OnnxModelRuntime.ModelUnavailableException.class)
                    .hasMessage("Inference model is not ready")
                    .satisfies(failure -> assertThat(
                            ((OnnxModelRuntime.ModelUnavailableException) failure).outcome())
                            .isEqualTo(CanonicalModelDecision.Outcome.MODEL_UNAVAILABLE));
        }
    }

    @Test
    void syntheticFixtureRequiresBothAnExplicitFlagAndADevelopmentOrTestProfile() throws Exception {
        try (ConfigurableApplicationContext context = context(
                "--signconnect.inference.model.resource=" + MODEL_RESOURCE,
                "--signconnect.inference.model.labels-resource=" + LABEL_RESOURCE,
                "--signconnect.inference.model.expected-version=synthetic-v1",
                "--signconnect.inference.model.allow-mock-model=true")) {
            assertUnavailable(context);
        }
        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.allow-mock-model=false")) {
            assertUnavailable(context);
        }
    }

    @Test
    void defaultProfileRejectsABlockedNonGenuineNonMockModel() throws Exception {
        byte[] modelBytes = modelWithDifferentProducerName();
        Path model = temporaryDirectory.resolve("blocked-candidate.onnx");
        Files.write(model, modelBytes);

        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        metadata.put("mockModel", false);
        metadata.put("genuineSignLanguageData", false);
        ((ObjectNode) metadata.path("architecture")).put("family", "TCN");
        metadata.put("artifactSha256", sha256(modelBytes));
        ((ObjectNode) metadata.path("onnx"))
                .put("artifactPath", "models/blocked-candidate.onnx");
        Path labels = temporaryDirectory.resolve("blocked-candidate-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = context(
                "--signconnect.inference.model.resource=" + model.toUri(),
                "--signconnect.inference.model.labels-resource=" + labels.toUri(),
                "--signconnect.inference.model.expected-version=synthetic-v1")) {
            assertUnavailable(context);
        }
    }

    @Test
    void rejectsMalformedDirectRequestsBeforeAccessingTheModel() throws Exception {
        try (ConfigurableApplicationContext context = context()) {
            OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
            PredictionRequest valid = fixture(context, "inference-request-active.valid.json");
            List<PredictionRequest.Frame> missingMetadataFrames = new ArrayList<>(valid.frames());
            PredictionRequest.Frame first = missingMetadataFrames.getFirst();
            missingMetadataFrames.set(0, new PredictionRequest.Frame(
                    null,
                    first.timestampMs(),
                    first.features()));
            PredictionRequest missingMetadata = new PredictionRequest(
                    valid.schemaVersion(),
                    valid.requestId(),
                    valid.streamId(),
                    valid.windowSequence(),
                    missingMetadataFrames);

            List<PredictionRequest.Frame> wrongShapeFrames = new ArrayList<>(valid.frames());
            wrongShapeFrames.set(0, new PredictionRequest.Frame(
                    first.sequence(),
                    first.timestampMs(),
                    first.features().subList(0, PredictionRequest.FEATURE_COUNT - 1)));
            PredictionRequest wrongShape = new PredictionRequest(
                    valid.schemaVersion(),
                    valid.requestId(),
                    valid.streamId(),
                    valid.windowSequence(),
                    wrongShapeFrames);

            assertInvalidDirectRequest(runtime, missingMetadata);
            assertInvalidDirectRequest(runtime, wrongShape);
        }
    }

    @Test
    void missingArtifactLeavesReadinessUnavailable() throws Exception {
        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.resource=file:///definitely-missing/sign-model.onnx")) {
            assertUnavailable(context);
        }
    }

    @Test
    void corruptArtifactLeavesReadinessUnavailableWithoutLeakingItsLocation() throws Exception {
        Path corruptModel = temporaryDirectory.resolve("private-corrupt-model.onnx");
        Files.write(corruptModel, new byte[]{1, 2, 3, 4, 5});

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.resource=" + corruptModel.toUri())) {
            assertUnavailable(context);
            assertThat(context.getBean(ModelReadinessHealthIndicator.class).health().getDetails().toString())
                    .doesNotContain(corruptModel.toString(), corruptModel.getFileName().toString());
        }
    }

    @Test
    void artifactDigestMismatchLeavesReadinessUnavailable() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata;
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            metadata = (ObjectNode) objectMapper.readTree(input);
        }
        metadata.put("artifactSha256", "0".repeat(64));
        Path labels = temporaryDirectory.resolve("mismatched-artifact-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void selectedModelVersionMismatchLeavesReadinessUnavailable() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        metadata.put("modelVersion", "synthetic-v2");
        Path labels = temporaryDirectory.resolve("wrong-model-version-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void incompatibleMinimumRuntimeVersionLeavesReadinessUnavailable() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        ((ObjectNode) metadata.get("runtime")).put("minimumVersion", "999.0.0");
        Path labels = temporaryDirectory.resolve("future-runtime-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void metadataArtifactPathMismatchLeavesReadinessUnavailable() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        ((ObjectNode) metadata.get("onnx")).put("artifactPath", "models/other-model.onnx");
        Path labels = temporaryDirectory.resolve("wrong-artifact-path-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void bundledSyntheticArtifactCannotBeRelabeledAsARealModel() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata;
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            metadata = (ObjectNode) objectMapper.readTree(input);
        }
        metadata.put("mockModel", false);
        Path labels = temporaryDirectory.resolve("relabeled-synthetic-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void wrongInputShapeLeavesReadinessUnavailable() throws Exception {
        Path wrongShapeModel = temporaryDirectory.resolve("wrong-shape.onnx");
        byte[] modelBytes = modelWithFrameDimension(29);
        Files.write(wrongShapeModel, modelBytes);
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        metadata.put("artifactSha256", sha256(modelBytes));
        ((ObjectNode) metadata.get("onnx")).put("artifactPath", "models/wrong-shape.onnx");
        Path labels = temporaryDirectory.resolve("wrong-shape-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.resource=" + wrongShapeModel.toUri(),
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void missingConfiguredInputOrOutputNodeLeavesReadinessUnavailable() throws Exception {
        try (ConfigurableApplicationContext inputContext = localContext(
                "--signconnect.inference.model.input-name=missing_input")) {
            assertUnavailable(inputContext);
        }
        try (ConfigurableApplicationContext outputContext = localContext(
                "--signconnect.inference.model.output-name=missing_output")) {
            assertUnavailable(outputContext);
        }
    }

    @Test
    void labelCountMismatchLeavesReadinessUnavailable() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        ArrayNode labelsNode = metadata.withArray("labels");
        ObjectNode thirdLabel = labelsNode.addObject();
        thirdLabel.put("index", 2);
        thirdLabel.put("id", "OTHER_SIGN");
        thirdLabel.put("captionText", "Other sign.");
        thirdLabel.put("outcome", "SIGN");
        ((ObjectNode) metadata.get("output")).withArray("shape").set(
                1, objectMapper.getNodeFactory().numberNode(3));
        Path labels = temporaryDirectory.resolve("private-label-map.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
    }

    @Test
    void malformedSoftmaxProbabilitySumFailsClosed() {
        assertThatThrownBy(() -> OnnxModelRuntime.validateProbabilityVector(
                new float[]{0.9f, 0.9f}))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Model output is not a normalized probability vector");
        assertThatThrownBy(() -> OnnxModelRuntime.validateProbabilityVector(
                new float[]{0.2f, 0.3f}))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Model output is not a normalized probability vector");
        assertThat(OnnxModelRuntime.validateProbabilityVector(new float[]{0.2f, 0.8f}))
                .containsExactly(0.2f, 0.8f);
    }

    @Test
    void closesRetainedNativeResourcesExactlyOnceAtShutdown() throws Exception {
        ConfigurableApplicationContext context = localContext();
        OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
        runtime.predict(fixture(context, "inference-request-active.valid.json"));

        context.close();
        context.close();

        assertThat(runtime.shutdownCount()).isOne();
        assertThat(runtime.sessionCloseCount()).isOne();
        assertThat(runtime.environmentCloseCount()).isOne();
        assertThat(runtime.outstandingInvocationResources()).isZero();
    }

    private ConfigurableApplicationContext localContext(String... extraArguments) {
        String[] arguments = new String[extraArguments.length + 2];
        arguments[0] = "--spring.profiles.active=local";
        arguments[1] = "--spring.main.banner-mode=off";
        System.arraycopy(extraArguments, 0, arguments, 2, extraArguments.length);
        return context(arguments);
    }

    private ConfigurableApplicationContext context(String... arguments) {
        return new SpringApplicationBuilder(SignInferenceServiceApplication.class)
                .web(WebApplicationType.NONE)
                .logStartupInfo(false)
                .run(arguments);
    }

    private static void assertUnavailable(ConfigurableApplicationContext context) throws Exception {
        OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
        assertThat(runtime.isReady()).isFalse();
        assertThat(context.getBean(ModelReadinessHealthIndicator.class).health().getStatus().getCode())
                .isEqualTo("DOWN");
        assertThatThrownBy(() -> runtime.predict(fixture(context, "inference-request-active.valid.json")))
                .isInstanceOf(OnnxModelRuntime.ModelUnavailableException.class);
    }

    private static void assertPrediction(PredictionResponse response, String labelId, boolean mockModel) {
        assertThat(response.labelId()).isEqualTo(labelId);
        assertThat(response.confidence()).isBetween(0.8, 1.0);
        assertThat(response.modelVersion()).isEqualTo("synthetic-v1");
        assertThat(response.inferenceLatencyMs()).isGreaterThanOrEqualTo(0.0);
        assertThat(response.mockModel()).isEqualTo(mockModel);
    }

    private static void assertInvalidDirectRequest(OnnxModelRuntime runtime, PredictionRequest request) {
        assertThatThrownBy(() -> runtime.predict(request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Request does not match inference contract");
    }

    private static PredictionRequest fixture(ConfigurableApplicationContext context, String name) throws IOException {
        return fixture(context.getBean(ObjectMapper.class), name);
    }

    private static PredictionRequest fixture(ObjectMapper objectMapper, String name) throws IOException {
        return objectMapper.readValue(
                contractsRoot().resolve("fixtures").resolve(name).toFile(),
                PredictionRequest.class);
    }

    private static byte[] modelWithFrameDimension(int frameCount) throws IOException {
        if (frameCount < 0 || frameCount > 127) {
            throw new IllegalArgumentException("Test helper supports one-byte dimensions only");
        }
        byte[] model;
        try (InputStream input = OnnxModelRuntimeTest.class.getResourceAsStream(
                "/models/deterministic-sign-v1.onnx")) {
            if (input == null) {
                throw new IllegalStateException("Synthetic ONNX test resource is missing");
            }
            model = input.readAllBytes();
        }

        byte[] shape = new byte[]{0x0A, 0x02, 0x08, 0x01, 0x0A, 0x02, 0x08, 0x1E,
                0x0A, 0x03, 0x08, (byte) 0xE0, 0x01};
        int match = indexOf(model, shape);
        if (match < 0) {
            throw new IllegalStateException("Synthetic model input-shape marker was not found");
        }
        model[match + 7] = (byte) frameCount;
        return model;
    }

    private static byte[] modelWithDifferentProducerName() throws IOException {
        byte[] model;
        try (InputStream input = OnnxModelRuntimeTest.class.getResourceAsStream(
                "/models/deterministic-sign-v1.onnx")) {
            if (input == null) {
                throw new IllegalStateException("Synthetic ONNX test resource is missing");
            }
            model = input.readAllBytes();
        }

        byte[] producerName = "SignConnect deterministic fixture generator"
                .getBytes(StandardCharsets.UTF_8);
        int match = indexOf(model, producerName);
        if (match < 0) {
            throw new IllegalStateException("Synthetic model producer marker was not found");
        }
        model[match] = (byte) Character.toLowerCase(model[match]);
        return model;
    }

    private static int indexOf(byte[] bytes, byte[] target) {
        outer:
        for (int index = 0; index <= bytes.length - target.length; index++) {
            for (int offset = 0; offset < target.length; offset++) {
                if (bytes[index + offset] != target[offset]) {
                    continue outer;
                }
            }
            return index;
        }
        return -1;
    }

    private ObjectNode canonicalMetadata(ObjectMapper objectMapper) throws IOException {
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            if (input == null) {
                throw new IllegalStateException("Synthetic model metadata is missing");
            }
            return (ObjectNode) objectMapper.readTree(input);
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Path contractsRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
            Path contracts = candidate.resolve("contracts/sign-recognition/v1");
            if (Files.isDirectory(contracts)) {
                return contracts;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("Could not locate repository inference contracts");
    }
}
