package com.signconnect.realtime.api;

public record RecognitionResultEvent(
        String type,
        long sequence,
        RecognitionPayload payload
) {
}