package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * Versioned performance evidence produced by the Java ONNX Runtime path.
 *
 * <p>The report deliberately carries raw measurement samples. Summary-only reports are not
 * accepted, and summaries are recomputed while loading the report. The unkeyed evidence digest
 * is a stable content identifier intended to be pinned by the promotion workflow. An embedded
 * digest can detect accidental corruption or a stale digest, but it does not authenticate the
 * measurement source because anyone who changes the report can recompute it. Performance policy
 * and trust in the independently pinned digest are evaluated elsewhere.</p>
 */
public record JavaInferencePerformanceReport(
        Integer schemaVersion,
        String benchmarkId,
        String recordedAt,
        EvidenceSource evidenceSource,
        String artifactSha256,
        String vocabularySha256,
        String modelId,
        String modelVersion,
        Environment environment,
        Protocol protocol,
        Measurements measurements,
        Summary summary,
        String evidenceDigestSha256) {

    private static final int SCHEMA_VERSION = 1;
    private static final int MINIMUM_MEASUREMENT_ITERATIONS = 20;
    private static final int MAXIMUM_MEASUREMENT_ITERATIONS = 100_000;
    private static final Pattern BENCHMARK_ID = Pattern.compile("^[a-z][a-z0-9-]{2,63}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final double DOUBLE_TOLERANCE = 1.0e-9;

    /**
     * Creates a report from measurements captured by the benchmark harness.
     * Summary values and the stable evidence digest are always derived, never supplied by the
     * caller. The digest is a content identifier, not a signature or attestation.
     */
    public static JavaInferencePerformanceReport createMeasured(
            ModelContract contract,
            String benchmarkId,
            String recordedAt,
            Environment environment,
            Protocol protocol,
            Measurements measurements) {
        if (contract == null) {
            throw invalid("a selected model contract is required");
        }
        if (!matches(BENCHMARK_ID, benchmarkId) || !isTimestamp(recordedAt)) {
            throw invalid("benchmark identity is incomplete or malformed");
        }
        if (environment == null) {
            throw invalid("runtime environment is required");
        }
        environment.validate();
        Summary summary = deriveSummary(protocol, measurements);
        JavaInferencePerformanceReport unsigned = new JavaInferencePerformanceReport(
                SCHEMA_VERSION,
                benchmarkId,
                recordedAt,
                EvidenceSource.MEASURED_JAVA_ONNX_RUNTIME,
                contract.artifactSha256(),
                contract.vocabularySha256(),
                contract.modelId(),
                contract.modelVersion(),
                environment,
                protocol,
                measurements,
                summary,
                null);
        JavaInferencePerformanceReport report = unsigned.withEvidenceDigestSha256(
                calculateStableEvidenceDigest(unsigned));
        report.validateFor(contract);
        return report;
    }

    /**
     * Reads imported evidence using a strict JSON shape, checks internal content integrity, and
     * binds it to the selected model. Source authenticity is out of scope; promotion must assess
     * provenance separately and compare this content identifier with its trusted pin.
     */
    public static JavaInferencePerformanceReport readFor(
            ObjectMapper objectMapper,
            InputStream input,
            ModelContract contract) throws IOException {
        if (objectMapper == null || input == null) {
            throw invalid("an object mapper and report input are required");
        }
        JavaInferencePerformanceReport report = objectMapper
                .readerFor(JavaInferencePerformanceReport.class)
                .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .readValue(input);
        report.validateFor(contract);
        return report;
    }

    /**
     * Validates completeness, arithmetic, digest integrity, and selected-artifact binding.
     */
    public void validateFor(ModelContract contract) {
        if (contract == null) {
            throw invalid("a selected model contract is required");
        }
        if (artifactSha256 == null || !artifactSha256.equals(contract.artifactSha256())) {
            throw invalid("report does not match the selected model artifact");
        }
        if (vocabularySha256 == null || !vocabularySha256.equals(contract.vocabularySha256())) {
            throw invalid("report does not match the selected model vocabulary");
        }
        if (modelId == null || modelVersion == null
                || !modelId.equals(contract.modelId())
                || !modelVersion.equals(contract.modelVersion())) {
            throw invalid("report does not match the selected model identity");
        }
        validateSelf();
    }

    private void validateSelf() {
        if (schemaVersion == null || schemaVersion != SCHEMA_VERSION
                || !matches(BENCHMARK_ID, benchmarkId)
                || !isTimestamp(recordedAt)
                || evidenceSource != EvidenceSource.MEASURED_JAVA_ONNX_RUNTIME
                || !matches(SHA256, artifactSha256)
                || !matches(SHA256, vocabularySha256)
                || !isBoundedText(modelId)
                || !isBoundedText(modelVersion)
                || environment == null || protocol == null || measurements == null
                || summary == null || !matches(SHA256, evidenceDigestSha256)) {
            throw invalid("report evidence is incomplete or malformed");
        }
        environment.validate();
        protocol.validate();
        measurements.validate(protocol.measurementIterations());

        Summary derived = deriveSummary(protocol, measurements);
        if (!summary.sameValues(derived)) {
            throw invalid("report summary is not derived from raw measurements");
        }
        if (!evidenceDigestSha256.equals(calculateStableEvidenceDigest(this))) {
            throw invalid("report content-integrity digest does not match its content");
        }
    }

    /**
     * Stable SHA-256 content identifier for external promotion pinning.
     *
     * <p>This value is unkeyed and is not proof of who produced the measurements. A trusted
     * workflow must pin it separately before it can protect against malicious replacement.</p>
     */
    @Override
    public String evidenceDigestSha256() {
        return evidenceDigestSha256;
    }

    private static Summary deriveSummary(Protocol protocol, Measurements measurements) {
        if (protocol == null || measurements == null) {
            throw invalid("raw benchmark measurements are required");
        }
        protocol.validate();
        measurements.validate(protocol.measurementIterations());

        List<Long> orderedLatencyNanos = new ArrayList<>(measurements.latencyNanos());
        orderedLatencyNanos.sort(Long::compareTo);
        double p50LatencyMs = nearestRank(orderedLatencyNanos, 0.50) / 1_000_000.0;
        double p95LatencyMs = nearestRank(orderedLatencyNanos, 0.95) / 1_000_000.0;
        double cpuTotal = 0.0;
        for (Double sample : measurements.processCpuLoadPercent()) {
            cpuTotal += sample;
        }
        double meanProcessCpuLoadPercent = cpuTotal
                / measurements.processCpuLoadPercent().size();
        long peakUsedHeapBytes = measurements.usedHeapBytes().stream()
                .mapToLong(Long::longValue)
                .max()
                .orElseThrow(() -> invalid("raw benchmark measurements are required"));
        double sustainedFps = protocol.measuredInferenceCount()
                / (protocol.measuredDurationNanos() / 1_000_000_000.0);
        return new Summary(
                p50LatencyMs,
                p95LatencyMs,
                meanProcessCpuLoadPercent,
                peakUsedHeapBytes,
                sustainedFps);
    }

    private static long nearestRank(List<Long> orderedValues, double percentile) {
        int rank = (int) Math.ceil(percentile * orderedValues.size());
        return orderedValues.get(Math.max(0, rank - 1));
    }

    private JavaInferencePerformanceReport withEvidenceDigestSha256(String digest) {
        return new JavaInferencePerformanceReport(
                schemaVersion,
                benchmarkId,
                recordedAt,
                evidenceSource,
                artifactSha256,
                vocabularySha256,
                modelId,
                modelVersion,
                environment,
                protocol,
                measurements,
                summary,
                digest);
    }

    private static String calculateStableEvidenceDigest(JavaInferencePerformanceReport report) {
        Map<String, Object> root = new TreeMap<>();
        root.put("artifactSha256", report.artifactSha256());
        root.put("benchmarkId", report.benchmarkId());
        root.put("environment", canonicalEnvironment(report.environment()));
        root.put("evidenceSource", report.evidenceSource().name());
        root.put("measurements", canonicalMeasurements(report.measurements()));
        root.put("modelId", report.modelId());
        root.put("modelVersion", report.modelVersion());
        root.put("protocol", canonicalProtocol(report.protocol()));
        root.put("recordedAt", report.recordedAt());
        root.put("schemaVersion", report.schemaVersion());
        root.put("summary", canonicalSummary(report.summary()));
        root.put("vocabularySha256", report.vocabularySha256());
        try {
            byte[] canonicalJson = new ObjectMapper().writeValueAsBytes(root);
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(canonicalJson));
        } catch (IOException | NoSuchAlgorithmException failure) {
            throw new IllegalStateException("Unable to calculate stable benchmark evidence digest", failure);
        }
    }

    private static Map<String, Object> canonicalEnvironment(Environment value) {
        Map<String, Object> result = new TreeMap<>();
        result.put("availableProcessors", value.availableProcessors());
        result.put("executionProvider", value.executionProvider());
        result.put("javaVersion", value.javaVersion());
        result.put("onnxRuntimeVersion", value.onnxRuntimeVersion());
        result.put("osArch", value.osArch());
        result.put("osName", value.osName());
        return result;
    }

    private static Map<String, Object> canonicalProtocol(Protocol value) {
        Map<String, Object> result = new TreeMap<>();
        result.put("batchSize", value.batchSize());
        result.put("concurrency", value.concurrency());
        result.put("measuredDurationNanos", value.measuredDurationNanos());
        result.put("measuredInferenceCount", value.measuredInferenceCount());
        result.put("measurementIterations", value.measurementIterations());
        result.put("warmupIterations", value.warmupIterations());
        return result;
    }

    private static Map<String, Object> canonicalMeasurements(Measurements value) {
        Map<String, Object> result = new TreeMap<>();
        result.put("latencyNanos", value.latencyNanos());
        result.put("processCpuLoadPercent", value.processCpuLoadPercent());
        result.put("usedHeapBytes", value.usedHeapBytes());
        return result;
    }

    private static Map<String, Object> canonicalSummary(Summary value) {
        Map<String, Object> result = new TreeMap<>();
        result.put("meanProcessCpuLoadPercent", value.meanProcessCpuLoadPercent());
        result.put("p50LatencyMs", value.p50LatencyMs());
        result.put("p95LatencyMs", value.p95LatencyMs());
        result.put("peakUsedHeapBytes", value.peakUsedHeapBytes());
        result.put("sustainedFps", value.sustainedFps());
        return result;
    }

    private static boolean matches(Pattern pattern, String value) {
        return value != null && pattern.matcher(value).matches();
    }

    private static boolean isTimestamp(String value) {
        if (value == null || !value.endsWith("Z")) {
            return false;
        }
        try {
            Instant.parse(value);
            return true;
        } catch (DateTimeParseException ignored) {
            return false;
        }
    }

    private static boolean isBoundedText(String value) {
        return value != null && !value.isBlank() && value.length() <= 128
                && value.chars().noneMatch(Character::isISOControl);
    }

    private static boolean sameDouble(Double left, Double right) {
        if (left == null || right == null || !Double.isFinite(left) || !Double.isFinite(right)) {
            return false;
        }
        double scale = Math.max(1.0, Math.max(Math.abs(left), Math.abs(right)));
        return Math.abs(left - right) <= DOUBLE_TOLERANCE * scale;
    }

    private static IllegalArgumentException invalid(String detail) {
        return new IllegalArgumentException("Invalid Java inference performance report: " + detail);
    }

    public enum EvidenceSource {
        MEASURED_JAVA_ONNX_RUNTIME
    }

    public record Environment(
            String javaVersion,
            String onnxRuntimeVersion,
            String osName,
            String osArch,
            String executionProvider,
            Integer availableProcessors) {

        private void validate() {
            if (!isBoundedText(javaVersion)
                    || !isBoundedText(onnxRuntimeVersion)
                    || !isBoundedText(osName)
                    || !isBoundedText(osArch)
                    || !"CPUExecutionProvider".equals(executionProvider)
                    || availableProcessors == null || availableProcessors < 1
                    || availableProcessors > 1_000_000) {
                throw invalid("runtime environment is incomplete or malformed");
            }
        }
    }

    public record Protocol(
            Integer warmupIterations,
            Integer measurementIterations,
            Integer batchSize,
            Integer concurrency,
            Long measuredDurationNanos,
            Long measuredInferenceCount) {

        private void validate() {
            if (warmupIterations == null || warmupIterations < 1
                    || measurementIterations == null
                    || measurementIterations < MINIMUM_MEASUREMENT_ITERATIONS
                    || measurementIterations > MAXIMUM_MEASUREMENT_ITERATIONS
                    || batchSize == null || batchSize != 1
                    || concurrency == null || concurrency != 1
                    || measuredDurationNanos == null || measuredDurationNanos <= 0
                    || measuredInferenceCount == null
                    || measuredInferenceCount != measurementIterations.longValue()) {
                throw invalid("benchmark protocol is incomplete or malformed");
            }
        }
    }

    public record Measurements(
            List<Long> latencyNanos,
            List<Double> processCpuLoadPercent,
            List<Long> usedHeapBytes) {

        public Measurements {
            latencyNanos = latencyNanos == null ? null : List.copyOf(latencyNanos);
            processCpuLoadPercent = processCpuLoadPercent == null
                    ? null : List.copyOf(processCpuLoadPercent);
            usedHeapBytes = usedHeapBytes == null ? null : List.copyOf(usedHeapBytes);
        }

        private void validate(int expectedCount) {
            if (latencyNanos == null || latencyNanos.size() != expectedCount
                    || processCpuLoadPercent == null
                    || processCpuLoadPercent.size() != expectedCount
                    || usedHeapBytes == null || usedHeapBytes.size() != expectedCount) {
                throw invalid("raw benchmark measurements are incomplete");
            }
            for (Long sample : latencyNanos) {
                if (sample == null || sample < 0) {
                    throw invalid("latency measurements are incomplete or malformed");
                }
            }
            for (Double sample : processCpuLoadPercent) {
                if (sample == null || !Double.isFinite(sample)
                        || sample < 0.0 || sample > 100.0) {
                    throw invalid("CPU measurements are incomplete or malformed");
                }
            }
            for (Long sample : usedHeapBytes) {
                if (sample == null || sample < 0) {
                    throw invalid("memory measurements are incomplete or malformed");
                }
            }
        }
    }

    public record Summary(
            Double p50LatencyMs,
            Double p95LatencyMs,
            Double meanProcessCpuLoadPercent,
            Long peakUsedHeapBytes,
            Double sustainedFps) {

        private boolean sameValues(Summary other) {
            return other != null
                    && sameDouble(p50LatencyMs, other.p50LatencyMs)
                    && sameDouble(p95LatencyMs, other.p95LatencyMs)
                    && sameDouble(meanProcessCpuLoadPercent, other.meanProcessCpuLoadPercent)
                    && peakUsedHeapBytes != null
                    && peakUsedHeapBytes.equals(other.peakUsedHeapBytes)
                    && sameDouble(sustainedFps, other.sustainedFps);
        }
    }
}
