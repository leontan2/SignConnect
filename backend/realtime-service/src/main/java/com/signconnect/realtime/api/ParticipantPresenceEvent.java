package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record ParticipantPresenceEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID participantId,
        long sequence,
        Payload payload,
        Instant occurredAt
) {
    public record Payload(String displayName, String role, boolean activeSigner) {
    }
}
