package com.signconnect.meeting.application;

import com.signconnect.meeting.domain.Meeting;
import com.signconnect.meeting.domain.MeetingStatus;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class MeetingRegistry {

    private final Map<UUID, Meeting> meetings = new ConcurrentHashMap<>();
    private final Clock clock;

    public MeetingRegistry() {
        this(Clock.systemUTC());
    }

    MeetingRegistry(Clock clock) {
        this.clock = clock;
    }

    public Meeting create(String title) {
        Meeting meeting = new Meeting(UUID.randomUUID(), title, MeetingStatus.READY, Instant.now(clock));
        meetings.put(meeting.id(), meeting);
        return meeting;
    }
}