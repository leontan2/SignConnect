package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record SignerDeniedEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID streamId,
        long sequence,
        Payload payload,
        Instant occurredAt) {

    public record Payload(UUID requestId, String reason) {
    }
}
