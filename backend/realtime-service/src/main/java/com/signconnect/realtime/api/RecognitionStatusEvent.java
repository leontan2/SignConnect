package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record RecognitionStatusEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID streamId,
        long sequence,
        Payload payload,
        Instant occurredAt) {

    public record Payload(
            String state,
            String reason,
            String message,
            String modelVersion,
            Boolean mockModel) {
    }
}
