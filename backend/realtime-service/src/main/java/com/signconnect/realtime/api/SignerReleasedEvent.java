package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record SignerReleasedEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID participantId,
        long sequence,
        Payload payload,
        Instant occurredAt) {

    public record Payload(UUID requestId, UUID streamId, String reason) {
    }
}
