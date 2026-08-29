package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record RoomSnapshotEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        long sequence,
        Payload payload,
        Instant occurredAt
) {
    public record Payload(List<Participant> participants) {
        public Payload {
            participants = List.copyOf(participants);
        }
    }

    public record Participant(UUID participantId, String displayName, String role) {
    }
}
