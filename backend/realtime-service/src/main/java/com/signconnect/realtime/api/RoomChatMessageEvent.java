package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record RoomChatMessageEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID participantId,
        UUID messageId,
        long sequence,
        Payload payload,
        Instant occurredAt
) {
    public record Payload(String text, String sourceDisplayName) {
    }
}
