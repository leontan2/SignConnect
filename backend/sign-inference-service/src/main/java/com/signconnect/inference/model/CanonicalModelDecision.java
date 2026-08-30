package com.signconnect.inference.model;

import java.util.Objects;

/**
 * Internal model-outcome vocabulary. The frozen v1 wire response does not carry this discriminator,
 * so explicit rejection safely crosses that boundary as {@code NO_SIGN} with no caption candidate.
 */
public record CanonicalModelDecision(
        Outcome outcome,
        String wireLabelId,
        String wireCaptionText,
        Double confidence) {

    public CanonicalModelDecision {
        Objects.requireNonNull(outcome, "outcome");
    }

    public static CanonicalModelDecision from(
            ModelContract.Label label,
            double confidence,
            double minimumConfidence) {
        Objects.requireNonNull(label, "label");
        if (!Double.isFinite(confidence) || confidence < 0.0 || confidence > 1.0
                || !Double.isFinite(minimumConfidence)
                || minimumConfidence <= 0.0 || minimumConfidence > 1.0) {
            throw new IllegalArgumentException("Model decision values are invalid");
        }
        return switch (label.outcome()) {
            case NO_SIGN -> new CanonicalModelDecision(Outcome.NO_SIGN, "NO_SIGN", null, confidence);
            case REJECT -> new CanonicalModelDecision(Outcome.REJECTED, "NO_SIGN", null, confidence);
            case SIGN -> confidence < minimumConfidence
                    ? new CanonicalModelDecision(
                            Outcome.LOW_CONFIDENCE, label.id(), label.captionText(), confidence)
                    : new CanonicalModelDecision(
                            Outcome.RECOGNIZED, label.id(), label.captionText(), confidence);
        };
    }

    public static CanonicalModelDecision unavailable() {
        return new CanonicalModelDecision(Outcome.MODEL_UNAVAILABLE, null, null, null);
    }

    public boolean canBecomeCaptionCandidate() {
        return outcome == Outcome.RECOGNIZED;
    }

    public enum Outcome {
        RECOGNIZED,
        NO_SIGN,
        REJECTED,
        LOW_CONFIDENCE,
        MODEL_UNAVAILABLE
    }
}
