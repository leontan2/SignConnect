package com.signconnect.realtime.api;

public record RecognitionPayload(
        String text,
        double confidence
) {
}