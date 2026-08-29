package com.signconnect.realtime.room;

import java.util.UUID;

public record RoomParticipant(
        UUID meetingId,
        UUID participantId,
        String displayName,
        String role
) {
}
