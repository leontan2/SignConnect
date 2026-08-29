package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record RoomErrorEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        long sequence,
        Payload payload,
        Instant occurredAt
) {
    public record Payload(String code, String message) {
    }
}
