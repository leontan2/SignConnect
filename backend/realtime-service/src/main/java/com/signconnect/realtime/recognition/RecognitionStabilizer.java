package com.signconnect.realtime.recognition;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Connection-local temporal stabilization for inference predictions.
 *
 * <p>The stabilizer deliberately accepts prediction metadata only. Landmark frames and tensors
 * remain owned by the rolling-window boundary and cannot be retained by this state machine.</p>
 */
public final class RecognitionStabilizer {

    public static final String NO_SIGN = "NO_SIGN";

    private final Clock clock;
    private final Settings settings;

    private String candidateLabel;
    private int candidateCount;
    private Prediction armedPrediction;
    private int idleCount;
    private String lastFinalLabel;
    private Instant lastFinalAt;
    private int unknownFailureCount;
    private Instant lastUnknownAt;

    public RecognitionStabilizer(Clock clock) {
        this(clock, Settings.defaults());
    }

    public RecognitionStabilizer(Clock clock, Settings settings) {
        this.clock = Objects.requireNonNull(clock, "clock");
        this.settings = Objects.requireNonNull(settings, "settings");
    }

    /**
     * Evaluates one ordered inference result and returns at most one observable outcome.
     */
    public synchronized Outcome evaluate(Prediction prediction) {
        Objects.requireNonNull(prediction, "prediction");
        return evaluate(prediction, !NO_SIGN.equals(prediction.labelId()));
    }

    /**
     * Evaluates one result together with the derived hand-presence signal from only the newest
     * stride. No landmark or tensor values enter this state machine.
     */
    public synchronized Outcome evaluate(Prediction prediction, boolean recentHandPresent) {
        Objects.requireNonNull(prediction, "prediction");

        if (NO_SIGN.equals(prediction.labelId())) {
            if (recentHandPresent) {
                return evaluateUnrecognizedActivity(prediction);
            }
            return evaluateIdle(prediction);
        }
        return evaluateActive(prediction);
    }

    /**
     * Evaluates one gesture whose temporal boundary has already been confirmed by the browser.
     * Each completed gesture is an independent occurrence, so rolling votes, idle finalization,
     * rate limiting, and duplicate cooldown do not apply.
     */
    public synchronized Outcome evaluateCompletedGesture(Prediction prediction) {
        Objects.requireNonNull(prediction, "prediction");
        Instant occurredAt = Instant.now(clock);
        if (NO_SIGN.equals(prediction.labelId())
                || prediction.confidence() < settings.confidenceThreshold()
                || prediction.captionText() == null) {
            return new Unknown(UnknownReason.LOW_CONFIDENCE, prediction, occurredAt);
        }
        return new Final(prediction, occurredAt);
    }

    /**
     * Clears every piece of connection/stream-local stabilization state.
     */
    public synchronized void reset() {
        candidateLabel = null;
        candidateCount = 0;
        armedPrediction = null;
        idleCount = 0;
        lastFinalLabel = null;
        lastFinalAt = null;
        unknownFailureCount = 0;
        lastUnknownAt = null;
    }

    private Outcome evaluateActive(Prediction prediction) {
        idleCount = 0;
        if (armedPrediction != null) {
            if (prediction.confidence() >= settings.confidenceThreshold()
                    && prediction.labelId().equals(armedPrediction.labelId())) {
                unknownFailureCount = 0;
                return None.INSTANCE;
            }
            return recordFailure(
                    prediction,
                    prediction.confidence() < settings.confidenceThreshold()
                            ? UnknownReason.LOW_CONFIDENCE
                            : UnknownReason.UNSTABLE_PREDICTION);
        }
        if (prediction.confidence() < settings.confidenceThreshold()) {
            candidateLabel = null;
            candidateCount = 0;
            return recordFailure(prediction, UnknownReason.LOW_CONFIDENCE);
        }

        if (prediction.labelId().equals(candidateLabel)) {
            candidateCount++;
            unknownFailureCount = 0;
        } else if (candidateLabel == null) {
            candidateLabel = prediction.labelId();
            candidateCount = 1;
            unknownFailureCount = 0;
        } else {
            candidateLabel = prediction.labelId();
            candidateCount = 1;
            return recordFailure(prediction, UnknownReason.UNSTABLE_PREDICTION);
        }

        if (candidateCount >= settings.stableEvaluationCount()) {
            armedPrediction = prediction;
        }
        return None.INSTANCE;
    }

    private Outcome evaluateUnrecognizedActivity(Prediction prediction) {
        idleCount = 0;
        if (armedPrediction == null) {
            candidateLabel = null;
            candidateCount = 0;
        }
        return recordFailure(prediction, UnknownReason.LOW_CONFIDENCE);
    }

    private Outcome evaluateIdle(Prediction prediction) {
        if (armedPrediction == null) {
            candidateLabel = null;
            candidateCount = 0;
            idleCount = 0;
            unknownFailureCount = 0;
            return None.INSTANCE;
        }

        idleCount++;
        if (idleCount < settings.idleEvaluationCount()) {
            return None.INSTANCE;
        }

        Prediction finalized = armedPrediction;
        Instant finalizedAt = Instant.now(clock);
        resetOccurrence();
        if (finalized.labelId().equals(lastFinalLabel)
                && finalizedAt.isBefore(lastFinalAt.plus(settings.duplicateCooldown()))) {
            return None.INSTANCE;
        }
        lastFinalLabel = finalized.labelId();
        lastFinalAt = finalizedAt;
        return new Final(finalized, finalizedAt);
    }

    private void resetOccurrence() {
        candidateLabel = null;
        candidateCount = 0;
        armedPrediction = null;
        idleCount = 0;
        unknownFailureCount = 0;
    }

    private Outcome recordFailure(Prediction prediction, UnknownReason reason) {
        if (unknownFailureCount < settings.unknownEvaluationCount()) {
            unknownFailureCount++;
        }
        if (unknownFailureCount < settings.unknownEvaluationCount()) {
            return None.INSTANCE;
        }

        if (armedPrediction != null) {
            candidateLabel = null;
            candidateCount = 0;
            armedPrediction = null;
            idleCount = 0;
        }

        Instant now = Instant.now(clock);
        if (lastUnknownAt != null
                && now.isBefore(lastUnknownAt.plus(settings.unknownRateLimit()))) {
            return None.INSTANCE;
        }
        lastUnknownAt = now;
        return new Unknown(reason, prediction, now);
    }

    public record Settings(
            double confidenceThreshold,
            int stableEvaluationCount,
            int idleEvaluationCount,
            Duration duplicateCooldown,
            int unknownEvaluationCount,
            Duration unknownRateLimit) {

        public Settings {
            if (!Double.isFinite(confidenceThreshold)
                    || confidenceThreshold < 0.80
                    || confidenceThreshold > 1.0) {
                throw new IllegalArgumentException("confidenceThreshold must be finite and in [0.80, 1.0]");
            }
            if (stableEvaluationCount < 1) {
                throw new IllegalArgumentException("stableEvaluationCount must be positive");
            }
            if (idleEvaluationCount < 1) {
                throw new IllegalArgumentException("idleEvaluationCount must be positive");
            }
            Objects.requireNonNull(duplicateCooldown, "duplicateCooldown");
            if (duplicateCooldown.isZero()
                    || duplicateCooldown.isNegative()
                    || duplicateCooldown.compareTo(Duration.ofMinutes(1)) > 0) {
                throw new IllegalArgumentException("duplicateCooldown must be positive and bounded");
            }
            if (unknownEvaluationCount < 2) {
                throw new IllegalArgumentException("unknownEvaluationCount must represent repeated evaluations");
            }
            Objects.requireNonNull(unknownRateLimit, "unknownRateLimit");
            if (unknownRateLimit.isZero() || unknownRateLimit.isNegative()) {
                throw new IllegalArgumentException("unknownRateLimit must be positive");
            }
        }

        public static Settings defaults() {
            return new Settings(
                    0.80,
                    3,
                    2,
                    Duration.ofMillis(1_500),
                    3,
                    Duration.ofSeconds(2));
        }
    }

    public record Prediction(
            int schemaVersion,
            UUID requestId,
            UUID streamId,
            long windowSequence,
            String labelId,
            String captionText,
            double confidence,
            String modelVersion,
            double inferenceLatencyMs,
            boolean mockModel) {

        public Prediction {
            if (schemaVersion != 1) {
                throw new IllegalArgumentException("schemaVersion must be 1");
            }
            Objects.requireNonNull(requestId, "requestId");
            Objects.requireNonNull(streamId, "streamId");
            if (windowSequence < 0) {
                throw new IllegalArgumentException("windowSequence must not be negative");
            }
            if (labelId == null || labelId.isEmpty() || labelId.length() > 64
                    || !labelId.matches("[A-Z][A-Z0-9_]*")) {
                throw new IllegalArgumentException("labelId does not match the v1 prediction contract");
            }
            if (captionText != null && (captionText.isEmpty() || captionText.length() > 240)) {
                throw new IllegalArgumentException("captionText does not match the v1 prediction contract");
            }
            if (!Double.isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
                throw new IllegalArgumentException("confidence must be finite and in [0.0, 1.0]");
            }
            if (modelVersion == null || modelVersion.isEmpty() || modelVersion.length() > 64
                    || !modelVersion.matches("[A-Za-z0-9][A-Za-z0-9._-]*")) {
                throw new IllegalArgumentException("modelVersion does not match the v1 prediction contract");
            }
            if (!Double.isFinite(inferenceLatencyMs) || inferenceLatencyMs < 0.0) {
                throw new IllegalArgumentException("inferenceLatencyMs must be finite and non-negative");
            }
        }
    }

    public sealed interface Outcome permits None, Final, Unknown {
    }

    public enum None implements Outcome {
        INSTANCE
    }

    public record Final(Prediction prediction, Instant occurredAt) implements Outcome {

        public Final {
            Objects.requireNonNull(prediction, "prediction");
            Objects.requireNonNull(occurredAt, "occurredAt");
        }
    }

    public record Unknown(
            UnknownReason reason,
            Prediction prediction,
            Instant occurredAt) implements Outcome {

        public Unknown {
            Objects.requireNonNull(reason, "reason");
            Objects.requireNonNull(prediction, "prediction");
            Objects.requireNonNull(occurredAt, "occurredAt");
        }
    }

    public enum UnknownReason {
        LOW_CONFIDENCE,
        UNSTABLE_PREDICTION
    }
}
