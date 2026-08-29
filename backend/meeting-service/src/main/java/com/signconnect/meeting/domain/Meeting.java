package com.signconnect.meeting.domain;

import java.time.Instant;
import java.util.UUID;

public record Meeting(
        UUID id,
        String title,
        String joinCode,
        MeetingStatus status,
        Instant createdAt
) {
}
