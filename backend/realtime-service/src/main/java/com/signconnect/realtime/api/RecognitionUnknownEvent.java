package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record RecognitionUnknownEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID streamId,
        long sequence,
        Payload payload,
        Instant occurredAt) {

    public record Payload(
            String reason,
            double confidence,
            String modelVersion,
            double inferenceLatencyMs,
            boolean mockModel) {
    }
}
