package com.signconnect.meeting.application;

import com.signconnect.meeting.domain.Meeting;
import com.signconnect.meeting.domain.MeetingStatus;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class MeetingRegistry {

    private static final char[] JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();
    private static final int JOIN_CODE_LENGTH = 6;

    private final Map<UUID, Meeting> meetings = new ConcurrentHashMap<>();
    private final Map<String, UUID> meetingIdsByJoinCode = new ConcurrentHashMap<>();
    private final Clock clock;
    private final SecureRandom secureRandom = new SecureRandom();

    public MeetingRegistry(Clock clock) {
        this.clock = clock;
    }

    public Meeting create(String title) {
        UUID meetingId = UUID.randomUUID();
        String joinCode = reserveJoinCode(meetingId);
        Meeting meeting = new Meeting(
                meetingId,
                title,
                joinCode,
                MeetingStatus.READY,
                Instant.now(clock));
        meetings.put(meeting.id(), meeting);
        return meeting;
    }

    public Optional<Meeting> findById(UUID meetingId) {
        return Optional.ofNullable(meetings.get(meetingId));
    }

    public Optional<Meeting> findByJoinCode(String joinCode) {
        if (joinCode == null) {
            return Optional.empty();
        }
        UUID meetingId = meetingIdsByJoinCode.get(joinCode.trim().toUpperCase(Locale.ROOT));
        return meetingId == null ? Optional.empty() : findById(meetingId);
    }

    private String reserveJoinCode(UUID meetingId) {
        while (true) {
            StringBuilder candidate = new StringBuilder(JOIN_CODE_LENGTH);
            for (int index = 0; index < JOIN_CODE_LENGTH; index++) {
                candidate.append(JOIN_CODE_ALPHABET[secureRandom.nextInt(JOIN_CODE_ALPHABET.length)]);
            }
            String joinCode = candidate.toString();
            if (meetingIdsByJoinCode.putIfAbsent(joinCode, meetingId) == null) {
                return joinCode;
            }
        }
    }
}
