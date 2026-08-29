package com.signconnect.meeting.api;

import com.signconnect.meeting.application.MeetingAccessService;

import java.time.Instant;

public record MeetingSessionResponse(
        MeetingResponse meeting,
        ParticipantResponse participant,
        String realtimeTicket,
        Instant realtimeTicketExpiresAt
) {
    static MeetingSessionResponse from(MeetingAccessService.IssuedSession session) {
        return new MeetingSessionResponse(
                MeetingResponse.from(session.meeting()),
                new ParticipantResponse(session.participantId(), session.displayName(), session.role()),
                session.realtimeTicket(),
                session.realtimeTicketExpiresAt());
    }
}
