package com.signconnect.inference;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.DoubleNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.signconnect.inference.model.InferenceConcurrencyLimiter;
import com.signconnect.inference.model.OnnxModelRuntime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.http.MediaType;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.anyOf;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.lessThanOrEqualTo;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "debug=false",
        "logging.level.org.springframework.web.servlet.mvc.method.annotation=TRACE",
        "signconnect.inference.limits.max-concurrent-predictions=1",
        "signconnect.inference.limits.concurrency-acquire-timeout-ms=0"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
@ExtendWith(OutputCaptureExtension.class)
class PredictionApiTest {

    private static final String PREDICTIONS_PATH = "/api/v1/predictions";
    private static final String SENTINEL = "913579.2468";
    private static final String QUOTED_FEATURE_SENTINEL =
            "PRIVATE_FEATURE_SCALAR_62f4dc40-46c4-4d85-aabc-423fa05f0bf4";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private InferenceConcurrencyLimiter concurrencyLimiter;

    @Autowired
    private OnnxModelRuntime modelRuntime;

    @Test
    void predictsSharedActiveFixtureThroughRealSyntheticModel() throws Exception {
        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(fixture("inference-request-active.valid.json")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.schemaVersion").value(1))
                .andExpect(jsonPath("$.requestId").value("aaaaaaaa-aaaa-4aaa-8aaa-000000000001"))
                .andExpect(jsonPath("$.streamId").value("11111111-1111-4111-8111-111111111111"))
                .andExpect(jsonPath("$.windowSequence").value(0))
                .andExpect(jsonPath("$.labelId").value("MOCK_ACTIVE"))
                .andExpect(jsonPath("$.captionText").value("Synthetic active gesture"))
                .andExpect(jsonPath("$.confidence", greaterThanOrEqualTo(0.8)))
                .andExpect(jsonPath("$.confidence", lessThanOrEqualTo(1.0)))
                .andExpect(jsonPath("$.modelVersion").value("synthetic-v1"))
                .andExpect(jsonPath("$.inferenceLatencyMs", greaterThanOrEqualTo(0.0)))
                .andExpect(jsonPath("$.mockModel").value(true));
    }

    @Test
    void predictsSharedIdleFixtureThroughRealSyntheticModel() throws Exception {
        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(fixture("inference-request-idle.valid.json")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.requestId").value("aaaaaaaa-aaaa-4aaa-8aaa-000000000002"))
                .andExpect(jsonPath("$.windowSequence").value(1))
                .andExpect(jsonPath("$.labelId").value("NO_SIGN"))
                .andExpect(jsonPath("$.captionText").value((Object) null))
                .andExpect(jsonPath("$.confidence", greaterThanOrEqualTo(0.8)))
                .andExpect(jsonPath("$.confidence", lessThanOrEqualTo(1.0)))
                .andExpect(jsonPath("$.modelVersion").value("synthetic-v1"))
                .andExpect(jsonPath("$.inferenceLatencyMs", greaterThanOrEqualTo(0.0)))
                .andExpect(jsonPath("$.mockModel").value(true));
    }

    @ParameterizedTest(name = "rejects shared invalid fixture {0}")
    @ValueSource(strings = {
            "inference-request-wrong-version.invalid.json",
            "inference-request-wrong-frame-count.invalid.json",
            "inference-request-wrong-feature-count.invalid.json",
            "inference-request-non-number.invalid.json",
            "inference-request-missing-stream-id.invalid.json",
            "inference-request-extra-raw-frame.invalid.json"
    })
    void rejectsSharedInvalidFixturesWithoutEchoingPayload(String fixtureName) throws Exception {
        String response = mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(fixture(fixtureName)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"))
                .andExpect(jsonPath("$.message").isString())
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(response)
                .doesNotContain("features", "imageBase64", "NaN", "-0.45");
    }

    @Test
    void rejectsValuesThatOverflowTheFloatTensor() throws Exception {
        ObjectNode request = activeFixtureTree();
        features(request, 0).set(0, DoubleNode.valueOf(Double.MAX_VALUE));

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @ParameterizedTest(name = "rejects schema-invalid scalar coercion {0}")
    @ValueSource(strings = {
            "fractional-window-sequence",
            "quoted-coordinate",
            "base64-request-id"
    })
    void rejectsValuesThatRelyOnJsonScalarCoercion(String coercion) throws Exception {
        ObjectNode request = activeFixtureTree();
        switch (coercion) {
            case "fractional-window-sequence" -> request.put("windowSequence", 0.5);
            case "quoted-coordinate" -> features(request, 0).set(
                    0,
                    objectMapper.getNodeFactory().textNode("0.5"));
            case "base64-request-id" -> request.put("requestId", "AAAAAAAAAAAAAAAAAAAAAA==");
            default -> throw new IllegalArgumentException("Unknown coercion test case");
        }

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @Test
    void rejectsTrailingJsonValues() throws Exception {
        String request = fixture("inference-request-active.valid.json") + " {}";

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(request))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @Test
    void rejectsValidationHelperNamesAsUnknownProperties() throws Exception {
        ObjectNode request = activeFixtureTree();
        request.put("frameOrderingValid", true);

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @Test
    void rejectsNonIncreasingFrameSequenceAndTimestamp() throws Exception {
        ObjectNode request = activeFixtureTree();
        ArrayNode frames = (ArrayNode) request.get("frames");
        ((ObjectNode) frames.get(1)).put("sequence", 0);
        ((ObjectNode) frames.get(1)).put("timestampMs", 0);

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    }

    @Test
    void neverLeaksSentinelValuesToErrorsOrLogs(CapturedOutput output) throws Exception {
        ObjectNode request = activeFixtureTree();
        request.put("schemaVersion", 2);
        features(request, 0).set(0, DoubleNode.valueOf(Double.parseDouble(SENTINEL)));

        String response = mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andReturn()
                .getResponse()
                .getContentAsString();

        ObjectNode wrongShape = activeFixtureTree();
        ArrayNode sensitiveFeatures = features(wrongShape, 0);
        sensitiveFeatures.set(0, DoubleNode.valueOf(Double.parseDouble(SENTINEL)));
        sensitiveFeatures.remove(sensitiveFeatures.size() - 1);
        String shapeResponse = mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(wrongShape)))
                .andExpect(status().isBadRequest())
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(response).doesNotContain(SENTINEL, "features", "tensor", "landmark");
        assertThat(shapeResponse).doesNotContain(SENTINEL, "features", "tensor", "landmark");
        assertThat(output.toString()).doesNotContain(SENTINEL, "913579.2468");
    }

    @Test
    void neverLogsMalformedQuotedFeatureValuesAtFrameworkTraceLevel(CapturedOutput output)
            throws Exception {
        ObjectNode request = activeFixtureTree();
        features(request, 0).set(
                0,
                objectMapper.getNodeFactory().textNode(QUOTED_FEATURE_SENTINEL));

        String response = mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsBytes(request)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_REQUEST"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(response).doesNotContain(QUOTED_FEATURE_SENTINEL);
        assertThat(output.toString()).doesNotContain(QUOTED_FEATURE_SENTINEL);
    }

    @Test
    void neverLogsSuccessfulPredictionMetadataAtFrameworkTraceLevel(CapturedOutput output)
            throws Exception {
        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(fixture("inference-request-active.valid.json")))
                .andExpect(status().isOk());

        assertThat(output.toString()).doesNotContain(
                "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
                "11111111-1111-4111-8111-111111111111",
                "MOCK_ACTIVE",
                "Synthetic active gesture",
                "synthetic-v1");
    }

    @Test
    void rejectsOversizedBodiesBeforeMvcBindingWithoutEchoingFragments() throws Exception {
        String bodySentinel = "PRIVATE_OVERSIZED_BODY_8b5bc7d8";
        String oversizedBody = "{\"private\":\"" + bodySentinel + "X".repeat(300_000) + "\"}";

        String response = mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(oversizedBody))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.status").value(413))
                .andExpect(jsonPath("$.code").value("PAYLOAD_TOO_LARGE"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(response).doesNotContain(bodySentinel, "private", "XXX");
    }

    @Test
    void returnsSafeBusyResponseWhenInferenceCapacityIsExhausted() throws Exception {
        try (InferenceConcurrencyLimiter.Lease ignored = concurrencyLimiter.acquire()) {
            mockMvc.perform(post(PREDICTIONS_PATH)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(fixture("inference-request-active.valid.json")))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.status").value(503))
                    .andExpect(jsonPath("$.code").value("INFERENCE_BUSY"))
                    .andExpect(jsonPath("$.message").value("Inference capacity is busy"));
            assertThat(modelRuntime.isReady()).isTrue();
        }

        mockMvc.perform(post(PREDICTIONS_PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(fixture("inference-request-active.valid.json")))
                .andExpect(status().isOk());
    }

    @Test
    void returnsPrivacySafe503WhenDefaultProfileModelIsUnavailable(CapturedOutput output) throws Exception {
        String boundedSentinel = "13.5792468";
        ObjectNode request = activeFixtureTree();
        features(request, 0).set(0, DoubleNode.valueOf(Double.parseDouble(boundedSentinel)));

        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(
                SignInferenceServiceApplication.class)
                .web(WebApplicationType.SERVLET)
                .profiles("default")
                .logStartupInfo(false)
                .run("--server.port=0", "--spring.main.banner-mode=off")) {
            MockMvc unavailableModelMvc = MockMvcBuilders
                    .webAppContextSetup((WebApplicationContext) context)
                    .build();

            String response = unavailableModelMvc.perform(post(PREDICTIONS_PATH)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsBytes(request)))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.status").value(503))
                    .andExpect(jsonPath("$.code").value("MODEL_UNAVAILABLE"))
                    .andReturn()
                    .getResponse()
                    .getContentAsString();

            assertThat(response).doesNotContain(boundedSentinel, "features", "tensor", "landmark");
            assertThat(output.toString()).doesNotContain(boundedSentinel, "features", "tensor", "landmark");
        }
    }

    @Test
    void exposesModelReadinessWithoutArtifactSecrets() throws Exception {
        String response = mockMvc.perform(get("/actuator/health/readiness"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value(anyOf(is("UP"), is("up"))))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(response).doesNotContain("deterministic-sign-v1.onnx", "file:", "classpath:");
    }

    private ObjectNode activeFixtureTree() throws IOException {
        return (ObjectNode) objectMapper.readTree(fixture("inference-request-active.valid.json"));
    }

    private static ArrayNode features(ObjectNode request, int frameIndex) {
        ArrayNode frames = (ArrayNode) request.get("frames");
        return (ArrayNode) frames.get(frameIndex).get("features");
    }

    private static String fixture(String name) throws IOException {
        return Files.readString(contractsRoot().resolve("fixtures").resolve(name));
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
