package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.inference.api.PredictionRequest;
import com.signconnect.inference.config.InferenceLimitsProperties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.DefaultResourceLoader;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JavaInferenceBenchmarkTest {

    private static final String MODEL_RESOURCE = "classpath:models/deterministic-sign-v1.onnx";
    private static final String LABEL_RESOURCE = "classpath:models/deterministic-sign-v1-labels.json";

    @Test
    void executesWarmupsAndMeasurementsAgainstTheSelectedJavaOnnxRuntime() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ModelContract contract = contract(objectMapper);
        AtomicLong inferenceTime = new AtomicLong();
        OnnxModelRuntime runtime = new OnnxModelRuntime(
                new DefaultResourceLoader(),
                objectMapper,
                MODEL_RESOURCE,
                LABEL_RESOURCE,
                "features",
                "probabilities",
                () -> inferenceTime.getAndAdd(2_000_000L),
                new InferenceConcurrencyLimiter(
                        new InferenceLimitsProperties(262_144, 1, 250L)));
        runtime.initialize();

        AtomicLong benchmarkTime = new AtomicLong();
        AtomicInteger samples = new AtomicInteger();
        try {
            JavaInferencePerformanceReport report = JavaInferenceBenchmark.runMeasured(
                    runtime,
                    request(objectMapper),
                    contract,
                    "deterministic-java-cpu",
                    "2026-08-30T14:00:00Z",
                    new JavaInferenceBenchmark.Configuration(3, 20),
                    () -> benchmarkTime.getAndAdd(2_000_000_000L),
                    () -> new JavaInferenceBenchmark.ResourceSample(
                            (double) samples.incrementAndGet(),
                            samples.get() * 1_000L),
                    new JavaInferencePerformanceReport.Environment(
                            "21.0.8",
                            "1.29.0",
                            "Windows 11",
                            "amd64",
                            "CPUExecutionProvider",
                            8));

            assertThat(runtime.predictionCount()).isEqualTo(23);
            assertThat(report.protocol().warmupIterations()).isEqualTo(3);
            assertThat(report.protocol().measurementIterations()).isEqualTo(20);
            assertThat(report.measurements().latencyNanos()).containsOnly(2_000_000L);
            assertThat(report.summary().p50LatencyMs()).isEqualTo(2.0);
            assertThat(report.summary().p95LatencyMs()).isEqualTo(2.0);
            assertThat(report.summary().meanProcessCpuLoadPercent()).isEqualTo(10.5);
            assertThat(report.summary().peakUsedHeapBytes()).isEqualTo(20_000L);
            assertThat(report.summary().sustainedFps()).isEqualTo(10.0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void refusesToLabelUnavailableOrUnmeasurableExecutionsAsEvidence() throws Exception {
        ObjectMapper objectMapper = new ObjectMapper();
        ModelContract contract = contract(objectMapper);
        OnnxModelRuntime unavailable = new OnnxModelRuntime(
                new DefaultResourceLoader(),
                objectMapper,
                "",
                "",
                "features",
                "probabilities",
                System::nanoTime,
                new InferenceConcurrencyLimiter(
                        new InferenceLimitsProperties(262_144, 1, 250L)));
        unavailable.initialize();

        assertThatThrownBy(() -> JavaInferenceBenchmark.runMeasured(
                unavailable,
                request(objectMapper),
                contract,
                "deterministic-java-cpu",
                "2026-08-30T14:00:00Z",
                new JavaInferenceBenchmark.Configuration(1, 20),
                () -> 0L,
                () -> new JavaInferenceBenchmark.ResourceSample(10.0, 1_000L),
                environment()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("ready selected runtime");
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

    private static ModelContract contract(ObjectMapper objectMapper) throws Exception {
        try (InputStream input = JavaInferenceBenchmarkTest.class.getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            if (input == null) {
                throw new IllegalStateException("Synthetic model metadata is missing");
            }
            return ModelContract.read(objectMapper, input);
        }
    }

    private static PredictionRequest request(ObjectMapper objectMapper) throws Exception {
        return objectMapper.readValue(
                contractsRoot().resolve("fixtures/inference-request-active.valid.json").toFile(),
                PredictionRequest.class);
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
