package com.signconnect.meeting.api;

import com.signconnect.meeting.domain.Meeting;
import com.signconnect.meeting.domain.MeetingStatus;

import java.time.Instant;
import java.util.UUID;

public record MeetingResponse(
        UUID id,
        String title,
        String joinCode,
        MeetingStatus status,
        Instant createdAt
) {
    static MeetingResponse from(Meeting meeting) {
        return new MeetingResponse(
                meeting.id(),
                meeting.title(),
                meeting.joinCode(),
                meeting.status(),
                meeting.createdAt());
    }
}
