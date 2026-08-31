package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.UUID;

public record RoomCallSignalEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID participantId,
        UUID targetParticipantId,
        UUID signalId,
        UUID callId,
        long sequence,
        JsonNode payload,
        Instant occurredAt
) {
}
