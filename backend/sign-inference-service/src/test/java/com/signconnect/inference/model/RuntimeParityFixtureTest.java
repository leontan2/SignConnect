package com.signconnect.inference.model;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtSession;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.inference.SignInferenceServiceApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.io.Resource;

import java.io.InputStream;
import java.nio.FloatBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RuntimeParityFixtureTest {

    private static final String MODEL_RESOURCE = "classpath:models/deterministic-sign-v1.onnx";
    private static final String METADATA_RESOURCE =
            "classpath:models/deterministic-sign-v1-labels.json";

    @Test
    void frozenFixtureMatchesJavaOnnxProbabilitiesAndCanonicalFinalDecisions() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        Path repositoryRoot = repositoryRoot();
        ParityFixture fixture = objectMapper.readValue(
                repositoryRoot.resolve(
                        "contracts/sign-recognition-training/v1/parity/"
                                + "deterministic-sign-v1.synthetic.json").toFile(),
                ParityFixture.class);

        assertThat(fixture.schemaVersion()).isEqualTo(1);
        assertThat(fixture.synthetic()).isTrue();
        assertThat(fixture.input().shape()).containsExactly(1, 30, 224);
        assertThat(fixture.input().frames()).isEqualTo(30);
        assertThat(fixture.input().featuresPerFrame()).isEqualTo(224);
        assertThat(fixture.input().handLandmarkCount()).isEqualTo(42);
        assertThat(fixture.input().presenceOffset()).isEqualTo(3);
        assertThat(fixture.input().landmarkStride()).isEqualTo(4);
        assertThat(fixture.absoluteTolerance()).isBetween(0.0, 1.0e-4);

        Path artifact = repositoryRoot.resolve(fixture.artifactPath()).normalize();
        Path metadataPath = repositoryRoot.resolve(fixture.metadataPath()).normalize();
        assertThat(artifact).isRegularFile();
        assertThat(metadataPath).isRegularFile();
        assertThat(artifact.startsWith(repositoryRoot)).isTrue();
        assertThat(metadataPath.startsWith(repositoryRoot)).isTrue();
        assertThat(sha256(Files.readAllBytes(artifact))).isEqualTo(fixture.artifactSha256());

        ModelContract contract;
        try (InputStream input = Files.newInputStream(metadataPath)) {
            contract = ModelContract.read(objectMapper, input);
        }
        assertThat(contract.artifactSha256()).isEqualTo(fixture.artifactSha256());
        assertThat(contract.modelVersion()).isEqualTo(fixture.modelVersion());
        assertThat(contract.vocabularyVersion()).isEqualTo(fixture.vocabularyVersion());
        assertThat(contract.vocabularySha256()).isEqualTo(fixture.vocabularySha256());

        try (ConfigurableApplicationContext context = localContext()) {
            OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
            assertThat(runtime.isReady()).isTrue();

            for (ParityVector vector : fixture.vectors()) {
                float[] input = input(fixture.input(), vector.activeHandLandmarksPerFrame());
                float[] actual;
                try (OnnxTensor tensor = OnnxTensor.createTensor(
                        runtime.environment(), FloatBuffer.wrap(input), new long[]{1, 30, 224});
                     OrtSession.Result result = runtime.session().run(Map.of("features", tensor))) {
                    actual = ((float[][]) result.get("probabilities").orElseThrow().getValue())[0];
                }
                assertThat(actual).as(vector.id() + " probabilities")
                        .containsExactly(vector.expectedProbabilities(),
                                org.assertj.core.data.Offset.offset(
                                        (float) fixture.absoluteTolerance()));

                int selected = highestProbabilityIndex(actual);
                CanonicalModelDecision decision = CanonicalModelDecision.from(
                        contract.labelAt(selected),
                        actual[selected],
                        contract.decision().minimumConfidence());
                assertThat(decision.outcome().name()).as(vector.id() + " outcome")
                        .isEqualTo(vector.expectedDecision().outcome());
                assertThat(decision.wireLabelId()).as(vector.id() + " wire label")
                        .isEqualTo(vector.expectedDecision().wireLabelId());
                assertThat(decision.wireCaptionText()).as(vector.id() + " caption")
                        .isEqualTo(vector.expectedDecision().wireCaptionText());
                assertThat(decision.confidence()).as(vector.id() + " confidence")
                        .isCloseTo(vector.expectedDecision().confidence(),
                                org.assertj.core.data.Offset.offset(
                                        fixture.absoluteTolerance()));
            }
        }
    }

    private static ConfigurableApplicationContext localContext(String... extraArguments) {
        String[] arguments = new String[extraArguments.length + 2];
        arguments[0] = "--spring.profiles.active=local";
        arguments[1] = "--spring.main.banner-mode=off";
        System.arraycopy(extraArguments, 0, arguments, 2, extraArguments.length);
        return new SpringApplicationBuilder(SignInferenceServiceApplication.class)
                .web(WebApplicationType.NONE)
                .logStartupInfo(false)
                .run(arguments);
    }

    private static float[] input(InputSpec specification, int activeHandLandmarksPerFrame) {
        assertThat(activeHandLandmarksPerFrame)
                .isBetween(0, specification.handLandmarkCount());
        float[] features = new float[specification.frames() * specification.featuresPerFrame()];
        for (int frame = 0; frame < specification.frames(); frame++) {
            int frameOffset = frame * specification.featuresPerFrame();
            for (int landmark = 0; landmark < activeHandLandmarksPerFrame; landmark++) {
                int feature = landmark * specification.landmarkStride()
                        + specification.presenceOffset();
                features[frameOffset + feature] = 1.0f;
            }
        }
        return features;
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

    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    private static Path repositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
            if (Files.isDirectory(candidate.resolve("contracts/sign-recognition-training/v1"))) {
                return candidate.normalize();
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("Could not locate repository root");
    }

    private record ParityFixture(
            int schemaVersion,
            String fixtureId,
            boolean synthetic,
            String artifactPath,
            String artifactSha256,
            String metadataPath,
            String modelVersion,
            String vocabularyVersion,
            String vocabularySha256,
            InputSpec input,
            double absoluteTolerance,
            List<ParityVector> vectors) {
    }

    private record InputSpec(
            int[] shape,
            int frames,
            int featuresPerFrame,
            int handLandmarkCount,
            int presenceOffset,
            int landmarkStride) {
    }

    private record ParityVector(
            String id,
            int activeHandLandmarksPerFrame,
            float[] expectedProbabilities,
            ExpectedDecision expectedDecision) {
    }

    private record ExpectedDecision(
            String outcome,
            String wireLabelId,
            String wireCaptionText,
            double confidence) {
    }
}
