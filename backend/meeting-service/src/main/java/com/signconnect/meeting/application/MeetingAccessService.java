package com.signconnect.meeting.application;

import com.signconnect.meeting.domain.Meeting;
import com.signconnect.meeting.domain.ParticipantRole;
import com.signconnect.realtimecontract.RealtimeTicketCodec;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

@Service
public class MeetingAccessService {

    private final MeetingRegistry meetingRegistry;
    private final RealtimeTicketCodec ticketCodec;
    private final Clock clock;
    private final java.time.Duration ticketTtl;

    public MeetingAccessService(
            MeetingRegistry meetingRegistry,
            RealtimeTicketCodec ticketCodec,
            Clock clock,
            com.signconnect.meeting.config.RealtimeAccessProperties properties) {
        this.meetingRegistry = meetingRegistry;
        this.ticketCodec = ticketCodec;
        this.clock = clock;
        this.ticketTtl = properties.getTicketTtl();
    }

    public IssuedSession create(String title, String displayName) {
        return issue(meetingRegistry.create(title), displayName, ParticipantRole.HOST);
    }

    public IssuedSession join(String joinCode, String displayName) {
        Meeting meeting = meetingRegistry.findByJoinCode(joinCode)
                .orElseThrow(() -> new MeetingNotFoundException("Meeting was not found"));
        return issue(meeting, displayName, ParticipantRole.GUEST);
    }

    public Meeting get(UUID meetingId) {
        return meetingRegistry.findById(meetingId)
                .orElseThrow(() -> new MeetingNotFoundException("Meeting was not found"));
    }

    private IssuedSession issue(Meeting meeting, String displayName, ParticipantRole role) {
        String normalizedName = displayName == null || displayName.isBlank()
                ? role == ParticipantRole.HOST ? "Host" : "Guest"
                : displayName.trim();
        UUID participantId = UUID.randomUUID();
        Instant expiresAt = clock.instant().plus(ticketTtl);
        String realtimeTicket = ticketCodec.issue(new RealtimeTicketCodec.Claims(
                meeting.id(),
                participantId,
                normalizedName,
                role.name().toUpperCase(Locale.ROOT),
                expiresAt));
        return new IssuedSession(meeting, participantId, normalizedName, role, realtimeTicket, expiresAt);
    }

    public record IssuedSession(
            Meeting meeting,
            UUID participantId,
            String displayName,
            ParticipantRole role,
            String realtimeTicket,
            Instant realtimeTicketExpiresAt) {
    }
}
