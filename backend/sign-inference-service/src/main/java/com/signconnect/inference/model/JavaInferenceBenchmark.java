package com.signconnect.inference.model;

import ai.onnxruntime.OrtEnvironment;
import com.signconnect.inference.api.PredictionRequest;
import com.signconnect.inference.api.PredictionResponse;

import java.lang.management.ManagementFactory;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** Runs the selected Java ONNX Runtime model and emits validated performance evidence. */
public final class JavaInferenceBenchmark {

    private static final int MINIMUM_MEASUREMENTS = 20;
    private static final int MAXIMUM_MEASUREMENTS = 100_000;

    private JavaInferenceBenchmark() {
    }

    /**
     * Executes a single-threaded, batch-one benchmark using process-local resource measurements.
     * No machine-dependent pass/fail threshold is applied here.
     */
    public static JavaInferencePerformanceReport runMeasured(
            OnnxModelRuntime runtime,
            PredictionRequest request,
            ModelContract contract,
            String benchmarkId,
            Configuration configuration) {
        return runMeasured(
                runtime,
                request,
                contract,
                benchmarkId,
                Instant.now().toString(),
                configuration,
                System::nanoTime,
                systemResourceSampler(),
                systemEnvironment());
    }

    static JavaInferencePerformanceReport runMeasured(
            OnnxModelRuntime runtime,
            PredictionRequest request,
            ModelContract contract,
            String benchmarkId,
            String recordedAt,
            Configuration configuration,
            NanoTimeSource nanoTimeSource,
            ResourceSampler resourceSampler,
            JavaInferencePerformanceReport.Environment environment) {
        if (runtime == null || contract == null || !runtime.usesContract(contract)) {
            throw new IllegalStateException(
                    "Benchmark requires a ready selected runtime matching the model contract");
        }
        if (request == null || !request.hasValidInferenceContract()) {
            throw new IllegalArgumentException("Benchmark request does not match the inference contract");
        }
        if (configuration == null || nanoTimeSource == null || resourceSampler == null
                || environment == null) {
            throw new IllegalArgumentException("Benchmark configuration is incomplete");
        }
        configuration.validate();

        for (int iteration = 0; iteration < configuration.warmupIterations(); iteration++) {
            runtime.predict(request);
        }

        List<Long> latencyNanos = new ArrayList<>(configuration.measurementIterations());
        List<Double> processCpuLoadPercent = new ArrayList<>(
                configuration.measurementIterations());
        List<Long> usedHeapBytes = new ArrayList<>(configuration.measurementIterations());
        long startedAt = nanoTimeSource.nanoTime();
        for (int iteration = 0; iteration < configuration.measurementIterations(); iteration++) {
            PredictionResponse response = runtime.predict(request);
            double inferenceLatencyMs = response.inferenceLatencyMs();
            if (!Double.isFinite(inferenceLatencyMs) || inferenceLatencyMs < 0.0) {
                throw new IllegalStateException("Runtime returned an invalid latency measurement");
            }
            latencyNanos.add(Math.round(inferenceLatencyMs * 1_000_000.0));

            ResourceSample resourceSample = resourceSampler.sample();
            if (resourceSample == null) {
                throw new IllegalStateException("Runtime resource measurements are unavailable");
            }
            processCpuLoadPercent.add(resourceSample.processCpuLoadPercent());
            usedHeapBytes.add(resourceSample.usedHeapBytes());
        }
        long completedAt = nanoTimeSource.nanoTime();
        long measuredDurationNanos;
        try {
            measuredDurationNanos = Math.subtractExact(completedAt, startedAt);
        } catch (ArithmeticException overflow) {
            throw new IllegalStateException("Benchmark duration measurement overflowed", overflow);
        }
        if (measuredDurationNanos <= 0) {
            throw new IllegalStateException("Benchmark duration measurement is unavailable");
        }

        return JavaInferencePerformanceReport.createMeasured(
                contract,
                benchmarkId,
                recordedAt,
                environment,
                new JavaInferencePerformanceReport.Protocol(
                        configuration.warmupIterations(),
                        configuration.measurementIterations(),
                        1,
                        1,
                        measuredDurationNanos,
                        (long) configuration.measurementIterations()),
                new JavaInferencePerformanceReport.Measurements(
                        latencyNanos,
                        processCpuLoadPercent,
                        usedHeapBytes));
    }

    private static JavaInferencePerformanceReport.Environment systemEnvironment() {
        return new JavaInferencePerformanceReport.Environment(
                boundedSystemProperty("java.version"),
                OrtEnvironment.getEnvironment().getVersion(),
                boundedSystemProperty("os.name"),
                boundedSystemProperty("os.arch"),
                "CPUExecutionProvider",
                Runtime.getRuntime().availableProcessors());
    }

    private static ResourceSampler systemResourceSampler() {
        com.sun.management.OperatingSystemMXBean operatingSystem =
                ManagementFactory.getPlatformMXBean(
                        com.sun.management.OperatingSystemMXBean.class);
        return () -> {
            if (operatingSystem == null) {
                throw new IllegalStateException("Process CPU measurement is unavailable");
            }
            double processCpuLoad = operatingSystem.getProcessCpuLoad();
            if (!Double.isFinite(processCpuLoad) || processCpuLoad < 0.0
                    || processCpuLoad > 1.0) {
                throw new IllegalStateException("Process CPU measurement is unavailable");
            }
            Runtime javaRuntime = Runtime.getRuntime();
            long usedHeapBytes = javaRuntime.totalMemory() - javaRuntime.freeMemory();
            return new ResourceSample(processCpuLoad * 100.0, usedHeapBytes);
        };
    }

    private static String boundedSystemProperty(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank() || value.length() > 128) {
            throw new IllegalStateException("Benchmark runtime environment is unavailable");
        }
        return value;
    }

    public record Configuration(Integer warmupIterations, Integer measurementIterations) {

        private void validate() {
            if (warmupIterations == null || warmupIterations < 1
                    || measurementIterations == null
                    || measurementIterations < MINIMUM_MEASUREMENTS
                    || measurementIterations > MAXIMUM_MEASUREMENTS) {
                throw new IllegalArgumentException("Benchmark iteration counts are invalid");
            }
        }
    }

    record ResourceSample(Double processCpuLoadPercent, Long usedHeapBytes) {
    }

    @FunctionalInterface
    interface NanoTimeSource {
        long nanoTime();
    }

    @FunctionalInterface
    interface ResourceSampler {
        ResourceSample sample();
    }
}
