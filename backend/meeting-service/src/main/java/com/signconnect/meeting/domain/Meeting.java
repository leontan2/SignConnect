package com.signconnect.meeting.domain;

import java.time.Instant;
import java.util.UUID;

public record Meeting(
        UUID id,
        String title,
        MeetingStatus status,
        Instant createdAt
) {
}