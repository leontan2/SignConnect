package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JavaInferencePerformanceReportTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void derivesArtifactBoundPerformanceEvidenceFromRawJavaMeasurements() throws Exception {
        ModelContract contract = bundledContract();

        JavaInferencePerformanceReport report = JavaInferencePerformanceReport.createMeasured(
                contract,
                "deterministic-java-cpu",
                "2026-08-30T14:00:00Z",
                environment(),
                protocol(),
                measurements());

        assertThat(report.schemaVersion()).isOne();
        assertThat(report.evidenceSource())
                .isEqualTo(JavaInferencePerformanceReport.EvidenceSource.MEASURED_JAVA_ONNX_RUNTIME);
        assertThat(report.artifactSha256()).isEqualTo(contract.artifactSha256());
        assertThat(report.vocabularySha256()).isEqualTo(contract.vocabularySha256());
        assertThat(report.summary().p50LatencyMs()).isEqualTo(10.0);
        assertThat(report.summary().p95LatencyMs()).isEqualTo(19.0);
        assertThat(report.summary().meanProcessCpuLoadPercent()).isEqualTo(10.5);
        assertThat(report.summary().peakUsedHeapBytes()).isEqualTo(2_000L);
        assertThat(report.summary().sustainedFps()).isEqualTo(10.0);
        assertThat(report.evidenceDigestSha256())
                .isEqualTo("0108b719babc07bf092ae35c2a826649fd6462031e4ed43211cad28fda83849f");
    }

    @Test
    void roundTripsOnlyWhenTheReportMatchesTheSelectedArtifactAndVocabulary() throws Exception {
        ModelContract contract = bundledContract();
        JavaInferencePerformanceReport created = validReport(contract);

        JavaInferencePerformanceReport read = JavaInferencePerformanceReport.readFor(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(created)),
                contract);

        assertThat(read).isEqualTo(created);

        ObjectNode wrongArtifact = (ObjectNode) objectMapper.valueToTree(created);
        wrongArtifact.put("artifactSha256", "0".repeat(64));
        assertInvalid(wrongArtifact, contract, "selected model artifact");

        ObjectNode wrongVocabulary = (ObjectNode) objectMapper.valueToTree(created);
        wrongVocabulary.put("vocabularySha256", "1".repeat(64));
        assertInvalid(wrongVocabulary, contract, "selected model vocabulary");
    }

    @Test
    void rejectsSelfReportedSummariesThatDoNotMatchRawSamples() throws Exception {
        ModelContract contract = bundledContract();
        ObjectNode report = (ObjectNode) objectMapper.valueToTree(validReport(contract));
        ((ObjectNode) report.path("summary")).put("p95LatencyMs", 1.0);

        assertInvalid(report, contract, "derived from raw measurements");
    }

    @Test
    void rejectsIncompleteOrEstimatedBenchmarkEvidence() throws Exception {
        ModelContract contract = bundledContract();
        ObjectNode missingSamples = (ObjectNode) objectMapper.valueToTree(validReport(contract));
        ((ObjectNode) missingSamples.path("measurements")).remove("processCpuLoadPercent");
        assertThatThrownBy(() -> read(missingSamples, contract))
                .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);

        ObjectNode estimated = (ObjectNode) objectMapper.valueToTree(validReport(contract));
        estimated.put("evidenceSource", "ESTIMATED");
        assertThatThrownBy(() -> read(estimated, contract))
                .isInstanceOfAny(IllegalArgumentException.class, java.io.IOException.class);
    }

    @Test
    void rejectsIncompleteMeasurementEnvironmentWithoutProducingAnEvidenceDigest() throws Exception {
        ModelContract contract = bundledContract();

        assertThatThrownBy(() -> JavaInferencePerformanceReport.createMeasured(
                contract,
                "deterministic-java-cpu",
                "2026-08-30T14:00:00Z",
                null,
                protocol(),
                measurements()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("environment");
    }

    @Test
    void detectsChangedContentWhenTheEmbeddedIntegrityDigestIsNotRecomputed() throws Exception {
        ModelContract contract = bundledContract();
        ObjectNode changed = (ObjectNode) objectMapper.valueToTree(validReport(contract));
        ((ArrayNode) changed.path("measurements").path("usedHeapBytes")).set(
                0, objectMapper.getNodeFactory().numberNode(101L));
        assertInvalid(changed, contract, "content-integrity digest");
    }

    @Test
    void rejectsUnknownReportFields() throws Exception {
        ModelContract contract = bundledContract();
        ObjectNode unknown = (ObjectNode) objectMapper.valueToTree(validReport(contract));
        unknown.put("claimedFastEnough", true);
        assertThatThrownBy(() -> read(unknown, contract))
                .isInstanceOf(java.io.IOException.class);
    }

    private JavaInferencePerformanceReport validReport(ModelContract contract) {
        return JavaInferencePerformanceReport.createMeasured(
                contract,
                "deterministic-java-cpu",
                "2026-08-30T14:00:00Z",
                environment(),
                protocol(),
                measurements());
    }

    private static JavaInferencePerformanceReport.Environment environment() {
        return new JavaInferencePerformanceReport.Environment(
                "21.0.8",
                "1.29.0",
                "Windows 11",
                "amd64",
                "CPUExecutionProvider",
                8);
    }

    private static JavaInferencePerformanceReport.Protocol protocol() {
        return new JavaInferencePerformanceReport.Protocol(
                10,
                20,
                1,
                1,
                2_000_000_000L,
                20L);
    }

    private static JavaInferencePerformanceReport.Measurements measurements() {
        return new JavaInferencePerformanceReport.Measurements(
                List.of(
                        1_000_000L, 2_000_000L, 3_000_000L, 4_000_000L, 5_000_000L,
                        6_000_000L, 7_000_000L, 8_000_000L, 9_000_000L, 10_000_000L,
                        11_000_000L, 12_000_000L, 13_000_000L, 14_000_000L, 15_000_000L,
                        16_000_000L, 17_000_000L, 18_000_000L, 19_000_000L, 20_000_000L),
                List.of(
                        1.0, 2.0, 3.0, 4.0, 5.0,
                        6.0, 7.0, 8.0, 9.0, 10.0,
                        11.0, 12.0, 13.0, 14.0, 15.0,
                        16.0, 17.0, 18.0, 19.0, 20.0),
                List.of(
                        100L, 200L, 300L, 400L, 500L,
                        600L, 700L, 800L, 900L, 1_000L,
                        1_100L, 1_200L, 1_300L, 1_400L, 1_500L,
                        1_600L, 1_700L, 1_800L, 1_900L, 2_000L));
    }

    private ModelContract bundledContract() throws Exception {
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            return ModelContract.read(objectMapper, input);
        }
    }

    private JavaInferencePerformanceReport read(ObjectNode report, ModelContract contract)
            throws Exception {
        return JavaInferencePerformanceReport.readFor(
                objectMapper,
                new ByteArrayInputStream(objectMapper.writeValueAsBytes(report)),
                contract);
    }

    private void assertInvalid(ObjectNode report, ModelContract contract, String message)
            throws Exception {
        assertThatThrownBy(() -> read(report, contract))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining(message);
    }
}
