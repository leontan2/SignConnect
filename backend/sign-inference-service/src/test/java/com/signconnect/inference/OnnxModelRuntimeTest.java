package com.signconnect.inference.model;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
                    .hasMessage("Inference model is not ready");
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
    void wrongInputShapeLeavesReadinessUnavailable() throws Exception {
        Path wrongShapeModel = temporaryDirectory.resolve("wrong-shape.onnx");
        Files.write(wrongShapeModel, modelWithFrameDimension(29));

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.resource=" + wrongShapeModel.toUri())) {
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
        Path labels = temporaryDirectory.resolve("private-label-map.json");
        Files.writeString(labels, """
                {
                  "schemaVersion": 1,
                  "modelVersion": "synthetic-v1",
                  "mockModel": true,
                  "labels": [
                    {"index": 0, "id": "NO_SIGN", "captionText": null}
                  ]
                }
                """);

        try (ConfigurableApplicationContext context = localContext(
                "--signconnect.inference.model.labels-resource=" + labels.toUri())) {
            assertUnavailable(context);
        }
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
