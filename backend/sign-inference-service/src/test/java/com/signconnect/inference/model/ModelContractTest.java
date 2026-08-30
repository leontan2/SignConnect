package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ModelContractTest {

    @Test
    void readsTheAuthoritativeFullMetadataDocument() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ModelContract contract;
        try (InputStream input = Files.newInputStream(
                authoritativeFixture("model-metadata-blocked.valid.json"))) {
            contract = ModelContract.read(objectMapper, input);
        }

        assertThat(contract.schemaVersion()).isEqualTo(1);
        assertThat(contract.modelVersion()).isEqualTo("synthetic-v1");
        assertThat(contract.mockModel()).isTrue();
        assertThat(contract.isProductionReady()).isFalse();
    }

    @Test
    void readsTheAuthoritativeApprovedProductionDocument() throws Exception {
        ModelContract contract;
        try (InputStream input = Files.newInputStream(
                authoritativeFixture("model-metadata-production.valid.json"))) {
            contract = ModelContract.read(new ObjectMapper(), input);
        }

        assertThat(contract.modelVersion()).isEqualTo("1.0.0-fixture");
        assertThat(contract.mockModel()).isFalse();
        assertThat(contract.isProductionReady()).isTrue();
    }

    @ParameterizedTest(name = "rejects missing authoritative section: {0}")
    @ValueSource(strings = {"trainingDataset", "productionPromotion"})
    void rejectsMissingProvenanceOrPromotionSections(String field) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = (ObjectNode) objectMapper.readTree(
                authoritativeFixture("model-metadata-blocked.valid.json").toFile());
        metadata.remove(field);

        assertThatThrownBy(() -> ModelContract.read(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(metadata))))
                .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);
    }

    @ParameterizedTest(name = "rejects authoritative invalid promotion metadata: {0}")
    @ValueSource(strings = {
            "model-metadata-approved-mock.invalid.json",
            "model-metadata-approved-without-consent.invalid.json",
            "model-metadata-approved-without-review.invalid.json",
            "model-metadata-approved-without-signer-independent-evaluation.invalid.json",
            "model-metadata-blocked-without-reasons.invalid.json",
            "model-metadata-incomplete-sgsl-review.invalid.json"
    })
    void rejectsAuthoritativeInvalidPromotionMetadata(String fixtureName) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        try (InputStream input = Files.newInputStream(authoritativeFixture(fixtureName))) {
            assertThatThrownBy(() -> ModelContract.read(objectMapper, input))
                    .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);
        }
    }

    @Test
    void rejectsMetadataWhoseMeasuredParityDifferenceExceedsItsTolerance() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ((ObjectNode) metadata.path("onnx").path("parity"))
                .put("maxAbsoluteDifference", 0.00002);

        assertInvalidMetadata(objectMapper, metadata);
    }

    @Test
    void rejectsApprovedMetadataWithUnmeasuredRuntimeLatency() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ((ObjectNode) metadata.path("runtime")).put("warmedP95LatencyMs", 0.0);

        assertInvalidMetadata(objectMapper, metadata);
    }

    @Test
    void bundledSyntheticMetadataIsAFullBlockedDocument() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);

        ModelContract.read(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(metadata)));

        assertThat(metadata.path("architecture").path("family").asText())
                .isEqualTo("SYNTHETIC_FIXTURE");
        assertThat(metadata.path("trainingDataset").isObject()).isTrue();
        assertThat(metadata.path("productionPromotion").path("status").asText())
                .isEqualTo("BLOCKED");
    }

    @Test
    void readsTheVersionedCanonicalFeatureAndOutputMetadata() throws Exception {
        ModelContract contract;
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            contract = ModelContract.read(new ObjectMapper(), input);
        }

        assertThat(contract.schemaVersion()).isEqualTo(1);
        assertThat(contract.artifactSha256())
                .isEqualTo("fd2cf50b2bdbe8c7c6953e0f809b33df2012de2a476b09fcff0e6987e289c4a8");
        assertThat(contract.input().name()).isEqualTo("features");
        assertThat(contract.input().shape()).containsExactly(1, 30, 224);
        assertThat(contract.input().tensorType()).isEqualTo("FLOAT32");
        assertThat(contract.input().featureLayoutVersion()).isEqualTo("mediapipe-holistic-224-v1");
        assertThat(contract.input().normalizationVersion())
                .isEqualTo("shoulder-midpoint-shoulder-width-v1");
        assertThat(contract.input().featureOrder()).containsExactlyElementsOf(List.of(
                "LEFT_HAND_0_20_XYZ_PRESENCE",
                "RIGHT_HAND_0_20_XYZ_PRESENCE",
                "POSE_11_24_XYZ_PRESENCE"));
        assertThat(contract.output().name()).isEqualTo("probabilities");
        assertThat(contract.output().shape()).containsExactly(1, 2);
        assertThat(contract.output().semanticsVersion())
                .isEqualTo("softmax-class-probabilities-v1");
        assertThat(contract.decision().minimumConfidence()).isEqualTo(0.8);
    }

    @ParameterizedTest(name = "rejects incompatible model metadata: {0}")
    @ValueSource(strings = {
            "schema-version",
            "input-shape",
            "feature-layout-version",
            "feature-order",
            "normalization-version",
            "output-shape",
            "output-semantics",
            "artifact-digest",
            "label-outcome",
            "unknown-field",
            "unknown-nested-field"
    })
    void rejectsIncompatibleOrMalformedMetadata(String mismatch) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = canonicalMetadata(objectMapper);
        ObjectNode input = (ObjectNode) metadata.get("input");
        ObjectNode output = (ObjectNode) metadata.get("output");
        switch (mismatch) {
            case "schema-version" -> metadata.put("schemaVersion", 2);
            case "input-shape" -> input.withArray("shape").set(1, objectMapper.getNodeFactory().numberNode(29));
            case "feature-layout-version" -> input.put("featureLayoutVersion", "mediapipe-holistic-225-v2");
            case "feature-order" -> {
                ArrayNode order = input.withArray("featureOrder");
                order.set(0, order.get(1));
            }
            case "normalization-version" -> input.put("normalizationVersion", "unversioned");
            case "output-shape" -> output.withArray("shape").set(
                    1, objectMapper.getNodeFactory().numberNode(3));
            case "output-semantics" -> output.put("semanticsVersion", "raw-logits-v1");
            case "artifact-digest" -> metadata.put("artifactSha256", "not-a-sha256");
            case "label-outcome" -> ((ObjectNode) metadata.withArray("labels").get(0))
                    .put("outcome", "SIGN");
            case "unknown-field" -> metadata.put("unversionedCompatibilityHint", true);
            case "unknown-nested-field" -> ((ObjectNode) metadata.get("runtime"))
                    .put("unversionedCompatibilityHint", true);
            default -> throw new IllegalArgumentException("Unknown test mismatch");
        }

        byte[] bytes = objectMapper.writeValueAsBytes(metadata);
        assertThatThrownBy(() -> ModelContract.read(
                objectMapper, new ByteArrayInputStream(bytes)))
                .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);
    }

    private ObjectNode canonicalMetadata(ObjectMapper objectMapper) throws Exception {
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            return (ObjectNode) objectMapper.readTree(input);
        }
    }

    private static ObjectNode authoritativeMetadata(ObjectMapper objectMapper, String name)
            throws Exception {
        return (ObjectNode) objectMapper.readTree(authoritativeFixture(name).toFile());
    }

    private static void assertInvalidMetadata(ObjectMapper objectMapper, ObjectNode metadata)
            throws Exception {
        byte[] bytes = objectMapper.writeValueAsBytes(metadata);
        assertThatThrownBy(() -> ModelContract.read(
                objectMapper, new ByteArrayInputStream(bytes)))
                .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);
    }

    private static Path authoritativeFixture(String name) {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
            Path fixture = candidate.resolve(
                    "contracts/sign-recognition-training/v1/fixtures").resolve(name);
            if (Files.isRegularFile(fixture)) {
                return fixture;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("Could not locate authoritative model metadata fixtures");
    }
}
