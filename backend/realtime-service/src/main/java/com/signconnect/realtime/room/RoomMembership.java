package com.signconnect.realtime.room;

import java.util.UUID;

public record RoomMembership(
        UUID connectionId,
        RoomParticipant participant
) {
}
