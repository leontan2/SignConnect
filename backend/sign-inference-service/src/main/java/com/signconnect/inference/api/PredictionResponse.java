package com.signconnect.inference.api;

import java.util.UUID;

public record PredictionResponse(
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

    @Override
    public String toString() {
        return "PredictionResponse[redacted]";
    }
}
