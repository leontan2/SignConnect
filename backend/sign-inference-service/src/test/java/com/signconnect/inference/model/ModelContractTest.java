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
    void acceptsOnlyTheIanaSingaporeSignLanguageTag() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-blocked.valid.json");
        metadata.put("targetLanguage", "sls");

        ModelContract contract = ModelContract.read(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(metadata)));

        assertThat(contract.targetLanguage()).isEqualTo("sls");

        metadata.put("targetLanguage", "sg-SG");
        assertInvalidMetadata(objectMapper, metadata);
    }

    @Test
    void readsTheAuthoritativeApprovedProductionDocument() throws Exception {
        ModelContract contract;
        try (InputStream input = Files.newInputStream(
                authoritativeFixture("model-metadata-production.valid.json"))) {
            contract = ModelContract.read(new ObjectMapper(), input);
        }

        assertThat(contract.modelVersion()).isEqualTo("1.0.0-fixture");
        assertThat(contract.vocabularyVersion()).isEqualTo("1.0.0");
        assertThat(contract.vocabularySha256())
                .isEqualTo("bee237eb48aeb5d54320f75d821b9ed93de2d143a3a12c91776df4f3560a5b26");
        assertThat(contract.sourceProvenance().dirty()).isFalse();
        assertThat(contract.sourceProvenance().untrackedFileCount()).isZero();
        assertThat(contract.mockModel()).isFalse();
        assertThat(contract.evaluation().metrics().perClass()).hasSize(7);
        assertThat(contract.evaluation().metrics().confusionMatrix().labelOrder())
                .containsExactly("NO_SIGN", "HELLO", "THANK_YOU", "YES", "NO", "HELP",
                        "OUT_OF_VOCABULARY");
        assertThat(contract.evaluation().metrics().rejectionBehavior().unknownRejectionRate())
                .isGreaterThanOrEqualTo(0.95);
        assertThat(contract.isProductionReady()).isTrue();
    }

    @ParameterizedTest(name = "rejects vocabulary binding mismatch: {0}")
    @ValueSource(strings = {
            "version",
            "digest",
            "caption",
            "label-order",
            "review-order"
    })
    void rejectsVocabularyBindingMismatch(String mismatch) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ArrayNode labels = metadata.withArray("labels");
        ArrayNode reviewed = (ArrayNode) metadata.path("sgslReview").path("reviewedLabelIds");
        switch (mismatch) {
            case "version" -> metadata.put("vocabularyVersion", "1.0.1");
            case "digest" -> metadata.put("vocabularySha256", "0".repeat(64));
            case "caption" -> ((ObjectNode) labels.get(1)).put("captionText", "hello");
            case "label-order" -> {
                String firstId = labels.get(1).path("id").asText();
                String firstCaption = labels.get(1).path("captionText").asText();
                ((ObjectNode) labels.get(1))
                        .put("id", labels.get(2).path("id").asText())
                        .put("captionText", labels.get(2).path("captionText").asText());
                ((ObjectNode) labels.get(2))
                        .put("id", firstId)
                        .put("captionText", firstCaption);
            }
            case "review-order" -> {
                String first = reviewed.get(0).asText();
                reviewed.set(0, reviewed.get(1));
                reviewed.set(1, objectMapper.getNodeFactory().textNode(first));
            }
            default -> throw new IllegalArgumentException("Unknown vocabulary mismatch");
        }

        assertInvalidMetadata(objectMapper, metadata);
    }

    @ParameterizedTest(name = "rejects production source provenance: {0}")
    @ValueSource(strings = {"missing", "dirty", "inconsistent"})
    void rejectsProductionSourceProvenance(String mismatch) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ObjectNode source = (ObjectNode) metadata.path("sourceProvenance");
        switch (mismatch) {
            case "missing" -> metadata.remove("sourceProvenance");
            case "dirty" -> {
                source.put("dirty", true);
                source.put("trackedChangesSha256", "a".repeat(64));
            }
            case "inconsistent" -> source.put("dirty", true);
            default -> throw new IllegalArgumentException("Unknown source mismatch");
        }
        assertInvalidMetadata(objectMapper, metadata);
    }

    @ParameterizedTest(name = "rejects inconsistent rich evaluation evidence: {0}")
    @ValueSource(strings = {
            "per-class-label",
            "summary-accuracy",
            "summary-macro-f1",
            "per-class-precision",
            "per-class-recall",
            "per-class-f1",
            "per-class-support",
            "confusion-total",
            "no-sign-rate",
            "no-sign-false-finals",
            "decision-threshold",
            "accepted-signs",
            "unknown-outcomes",
            "unknown-matrix-support",
            "accepted-accuracy-nullability",
            "robustness-support",
            "robustness-unknown-handedness"
    })
    void rejectsInconsistentRichEvaluationEvidence(String mismatch) throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ObjectNode metrics = (ObjectNode) metadata.path("evaluation").path("metrics");
        ObjectNode rejection = (ObjectNode) metrics.path("rejectionBehavior");
        switch (mismatch) {
            case "per-class-label" -> ((ObjectNode) metrics.withArray("perClass").get(1))
                    .put("labelId", "THANK_YOU");
            case "summary-accuracy" -> metrics.put("accuracy", 0.81);
            case "summary-macro-f1" -> metrics.put("macroF1", 0.81);
            case "per-class-precision" -> ((ObjectNode) metrics.withArray("perClass").get(1))
                    .put("precision", 0.81);
            case "per-class-recall" -> ((ObjectNode) metrics.withArray("perClass").get(1))
                    .put("recall", 0.81);
            case "per-class-f1" -> ((ObjectNode) metrics.withArray("perClass").get(1))
                    .put("f1", 0.81);
            case "per-class-support" -> ((ObjectNode) metrics.withArray("perClass").get(1))
                    .put("support", 24);
            case "confusion-total" -> ((ArrayNode) metrics.path("confusionMatrix").path("rows").get(0))
                    .set(0, objectMapper.getNodeFactory().numberNode(28));
            case "no-sign-rate" -> ((ObjectNode) metrics.path("noSignBehavior"))
                    .put("falseFinalRate", 0.04);
            case "no-sign-false-finals" -> ((ObjectNode) metrics.path("noSignBehavior"))
                    .put("falseFinalCount", 0);
            case "decision-threshold" -> rejection.put("minimumConfidence", 0.7);
            case "accepted-signs" -> rejection.put("acceptedSignCount", 138);
            case "unknown-outcomes" -> rejection.put("unknownRejectedCount", 28);
            case "unknown-matrix-support" -> {
                rejection.put("unknownSampleCount", 50);
                rejection.put("unknownRejectedCount", 49);
                rejection.put("unknownRejectionRate", 0.98);
                rejection.put("unknownFalseFinalCount", 1);
                rejection.put("unknownFalseFinalRate", 0.02);
            }
            case "accepted-accuracy-nullability" -> rejection.putNull("acceptedSignAccuracy");
            case "robustness-support" -> ((ObjectNode) metrics.path("robustnessSlices")
                    .path("lighting").get(0)).put("support", 179);
            case "robustness-unknown-handedness" -> ((ObjectNode) metrics.path("robustnessSlices")
                    .path("handedness").get(0)).put("value", "UNKNOWN");
            default -> throw new IllegalArgumentException("Unknown evaluation mismatch");
        }

        assertInvalidMetadata(objectMapper, metadata);
    }

    @Test
    void acceptsInternallyConsistentThresholdEvidenceNotEncodedByArgmaxMatrix() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata = authoritativeMetadata(
                objectMapper, "model-metadata-production.valid.json");
        ObjectNode rejection = (ObjectNode) metadata.path("evaluation").path("metrics")
                .path("rejectionBehavior");
        rejection.put("acceptedSignCount", 138);
        rejection.put("lowConfidenceRejectionCount", 7);
        rejection.put("rejectionRate", 7.0 / 180.0);

        ModelContract contract = ModelContract.read(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(metadata)));

        assertThat(contract.evaluation().metrics().rejectionBehavior()
                .lowConfidenceRejectionCount()).isEqualTo(7);
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
