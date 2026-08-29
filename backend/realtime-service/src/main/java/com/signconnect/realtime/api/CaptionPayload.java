package com.signconnect.realtime.api;

public record CaptionPayload(
        String labelId,
        String text,
        double confidence,
        String modelVersion,
        double inferenceLatencyMs,
        boolean mockModel
) {
}
