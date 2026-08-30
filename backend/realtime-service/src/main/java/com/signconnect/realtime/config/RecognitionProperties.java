package com.signconnect.realtime.config;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.convert.DataSizeUnit;
import org.springframework.boot.convert.DurationUnit;
import org.springframework.util.unit.DataSize;
import org.springframework.validation.annotation.Validated;

import java.net.URI;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.Set;

@Validated
@ConfigurationProperties("signconnect.recognition")
public class RecognitionProperties {

    private static final Set<String> HTTP_SCHEMES = Set.of("http", "https");
    // A v1 message contains five frames x 224 JSON numbers. This floor leaves bounded
    // serialization headroom for full-precision browser coordinates and envelope metadata.
    private static final long MIN_MESSAGE_SIZE_BYTES = 32L * 1_024L;

    @NotNull
    private URI inferenceUrl = URI.create("http://localhost:8083");

    @NotNull
    @DurationUnit(ChronoUnit.MILLIS)
    private Duration inferenceTimeout = Duration.ofMillis(500);

    @Min(30)
    @Max(30)
    private int windowFrames = 30;

    @Min(5)
    @Max(5)
    private int strideFrames = 5;

    @NotNull
    private InputMode inputMode = InputMode.SEGMENTED_GESTURES;

    @DecimalMin("0.80")
    @DecimalMax("1.0")
    private double confidenceThreshold = 0.80;

    @Min(1)
    @Max(30)
    private int stableActiveEvaluations = 3;

    @Min(1)
    @Max(30)
    private int idleEvaluations = 2;

    @NotNull
    @DurationUnit(ChronoUnit.MILLIS)
    private Duration duplicateCooldown = Duration.ofMillis(1_500);

    @NotNull
    @DurationUnit(ChronoUnit.MILLIS)
    private Duration unknownRateLimit = Duration.ofSeconds(2);

    @NotNull
    @DurationUnit(ChronoUnit.MILLIS)
    private Duration trackingTimeout = Duration.ofSeconds(2);

    @NotNull
    @DataSizeUnit(org.springframework.util.unit.DataUnit.BYTES)
    private DataSize maxMessageSize = DataSize.ofKilobytes(64);

    private boolean simulatorEnabled;

    @AssertTrue(message = "recognition configuration contains unsafe values")
    public boolean isSafeConfiguration() {
        return inferenceUrl != null
                && inferenceUrl.isAbsolute()
                && HTTP_SCHEMES.contains(inferenceUrl.getScheme())
                && inferenceUrl.getUserInfo() == null
                && positiveAndAtMost(inferenceTimeout, Duration.ofSeconds(10))
                && windowFrames == 30
                && strideFrames == 5
                && inputMode != null
                && Double.isFinite(confidenceThreshold)
                && confidenceThreshold >= 0.80
                && confidenceThreshold <= 1.0
                && stableActiveEvaluations > 0
                && idleEvaluations > 0
                && positiveAndAtMost(duplicateCooldown, Duration.ofMinutes(1))
                && positiveAndAtMost(unknownRateLimit, Duration.ofMinutes(1))
                && positiveAndAtMost(trackingTimeout, Duration.ofMinutes(1))
                && maxMessageSize != null
                && maxMessageSize.toBytes() >= MIN_MESSAGE_SIZE_BYTES
                && maxMessageSize.toBytes() <= DataSize.ofMegabytes(1).toBytes();
    }

    public int hardFramePayloadLimit() {
        long doubled = Math.multiplyExact(maxMessageSize.toBytes(), 2L);
        return Math.toIntExact(Math.min(doubled, DataSize.ofMegabytes(2).toBytes()));
    }

    private static boolean positiveAndAtMost(Duration value, Duration maximum) {
        return value != null && !value.isZero() && !value.isNegative() && value.compareTo(maximum) <= 0;
    }

    public URI getInferenceUrl() {
        return inferenceUrl;
    }

    public void setInferenceUrl(URI inferenceUrl) {
        this.inferenceUrl = inferenceUrl;
    }

    public Duration getInferenceTimeout() {
        return inferenceTimeout;
    }

    public void setInferenceTimeout(Duration inferenceTimeout) {
        this.inferenceTimeout = inferenceTimeout;
    }

    public int getWindowFrames() {
        return windowFrames;
    }

    public void setWindowFrames(int windowFrames) {
        this.windowFrames = windowFrames;
    }

    public int getStrideFrames() {
        return strideFrames;
    }

    public void setStrideFrames(int strideFrames) {
        this.strideFrames = strideFrames;
    }

    public InputMode getInputMode() {
        return inputMode;
    }

    public void setInputMode(InputMode inputMode) {
        this.inputMode = inputMode;
    }

    public int effectiveStrideFrames() {
        return inputMode == InputMode.SEGMENTED_GESTURES ? windowFrames : strideFrames;
    }

    public double getConfidenceThreshold() {
        return confidenceThreshold;
    }

    public void setConfidenceThreshold(double confidenceThreshold) {
        this.confidenceThreshold = confidenceThreshold;
    }

    public int getStableActiveEvaluations() {
        return stableActiveEvaluations;
    }

    public void setStableActiveEvaluations(int stableActiveEvaluations) {
        this.stableActiveEvaluations = stableActiveEvaluations;
    }

    public int getIdleEvaluations() {
        return idleEvaluations;
    }

    public void setIdleEvaluations(int idleEvaluations) {
        this.idleEvaluations = idleEvaluations;
    }

    public Duration getDuplicateCooldown() {
        return duplicateCooldown;
    }

    public void setDuplicateCooldown(Duration duplicateCooldown) {
        this.duplicateCooldown = duplicateCooldown;
    }

    public Duration getUnknownRateLimit() {
        return unknownRateLimit;
    }

    public void setUnknownRateLimit(Duration unknownRateLimit) {
        this.unknownRateLimit = unknownRateLimit;
    }

    public Duration getTrackingTimeout() {
        return trackingTimeout;
    }

    public void setTrackingTimeout(Duration trackingTimeout) {
        this.trackingTimeout = trackingTimeout;
    }

    public DataSize getMaxMessageSize() {
        return maxMessageSize;
    }

    public void setMaxMessageSize(DataSize maxMessageSize) {
        this.maxMessageSize = maxMessageSize;
    }

    public boolean isSimulatorEnabled() {
        return simulatorEnabled;
    }

    public void setSimulatorEnabled(boolean simulatorEnabled) {
        this.simulatorEnabled = simulatorEnabled;
    }

    public enum InputMode {
        SEGMENTED_GESTURES,
        ROLLING
    }
}
