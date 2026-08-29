package com.signconnect.meeting.api;

import com.signconnect.meeting.domain.ParticipantRole;

import java.util.UUID;

public record ParticipantResponse(
        UUID id,
        String displayName,
        ParticipantRole role
) {
}
