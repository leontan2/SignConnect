package com.signconnect.realtime.room;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.ParticipantPresenceEvent;
import com.signconnect.realtime.api.RoomCaptionEvent;
import com.signconnect.realtime.api.RoomJoinedEvent;
import com.signconnect.realtime.api.RoomSnapshotEvent;
import com.signconnect.realtime.config.RoomProperties;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

@Component
public class InMemoryRoomRegistry implements RoomRegistry {

    private final Map<UUID, RoomState> rooms = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;
    private final Clock clock;
    private final int maxParticipants;

    public InMemoryRoomRegistry(ObjectMapper objectMapper, Clock clock, RoomProperties properties) {
        this.objectMapper = objectMapper;
        this.clock = clock;
        if (properties.getMaxParticipants() < 2 || properties.getMaxParticipants() > 50) {
            throw new IllegalArgumentException("Room capacity must be between 2 and 50");
        }
        this.maxParticipants = properties.getMaxParticipants();
    }

    @Override
    public RoomMembership join(RoomParticipant participant, Consumer<String> outbound) {
        RoomState room = rooms.computeIfAbsent(participant.meetingId(), ignored -> new RoomState());
        RoomMembership membership;
        String joined;
        String snapshot;
        String presence;
        List<Connection> recipients;
        synchronized (room) {
            if (room.connections.size() >= maxParticipants) {
                throw new RoomCapacityExceededException();
            }
            membership = new RoomMembership(UUID.randomUUID(), participant);
            Connection connection = new Connection(membership, outbound);
            room.connections.put(membership.connectionId(), connection);
            Instant now = clock.instant();
            joined = serialize(new RoomJoinedEvent(
                    1,
                    "room.joined",
                    participant.meetingId(),
                    participant.participantId(),
                    room.nextSequence++,
                    new RoomJoinedEvent.Payload(participant.displayName(), participant.role()),
                    now));
            List<RoomSnapshotEvent.Participant> participants = room.connections.values().stream()
                    .map(Connection::membership)
                    .map(RoomMembership::participant)
                    .sorted(Comparator.comparing(RoomParticipant::displayName)
                            .thenComparing(item -> item.participantId().toString()))
                    .map(item -> new RoomSnapshotEvent.Participant(
                            item.participantId(), item.displayName(), item.role()))
                    .toList();
            snapshot = serialize(new RoomSnapshotEvent(
                    1,
                    "room.snapshot",
                    participant.meetingId(),
                    room.nextSequence++,
                    new RoomSnapshotEvent.Payload(participants),
                    now));
            presence = serialize(new ParticipantPresenceEvent(
                    1,
                    "participant.joined",
                    participant.meetingId(),
                    participant.participantId(),
                    room.nextSequence++,
                    new ParticipantPresenceEvent.Payload(participant.displayName(), participant.role()),
                    now));
            recipients = new ArrayList<>(room.connections.values());
        }

        outbound.accept(joined);
        outbound.accept(snapshot);
        recipients.forEach(connection -> connection.outbound().accept(presence));
        return membership;
    }

    @Override
    public void leave(RoomMembership membership) {
        if (membership == null) {
            return;
        }
        RoomState room = rooms.get(membership.participant().meetingId());
        if (room == null) {
            return;
        }
        String presence = null;
        List<Connection> recipients = List.of();
        boolean empty;
        synchronized (room) {
            Connection removed = room.connections.remove(membership.connectionId());
            if (removed == null) {
                return;
            }
            empty = room.connections.isEmpty();
            if (!empty) {
                presence = serialize(new ParticipantPresenceEvent(
                        1,
                        "participant.left",
                        membership.participant().meetingId(),
                        membership.participant().participantId(),
                        room.nextSequence++,
                        new ParticipantPresenceEvent.Payload(
                                membership.participant().displayName(),
                                membership.participant().role()),
                        clock.instant()));
                recipients = new ArrayList<>(room.connections.values());
            }
        }
        if (empty) {
            rooms.remove(membership.participant().meetingId(), room);
        } else {
            String event = presence;
            recipients.forEach(connection -> connection.outbound().accept(event));
        }
    }

    @Override
    public void publishCaption(RoomMembership source, CaptionEvent caption) {
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return;
        }
        String event;
        List<Connection> recipients;
        synchronized (room) {
            Connection active = room.connections.get(source.connectionId());
            if (active == null || !active.membership().equals(source)) {
                return;
            }
            event = serialize(new RoomCaptionEvent(
                    1,
                    "caption.final",
                    source.participant().meetingId(),
                    source.participant().participantId(),
                    UUID.randomUUID(),
                    caption.streamId(),
                    room.nextSequence++,
                    RoomCaptionEvent.Payload.from(caption.payload(), source.participant().displayName()),
                    caption.occurredAt()));
            recipients = new ArrayList<>(room.connections.values());
        }
        recipients.forEach(connection -> connection.outbound().accept(event));
    }

    private String serialize(Object event) {
        try {
            return objectMapper.writeValueAsString(event);
        } catch (JsonProcessingException exception) {
            throw new IllegalStateException("Could not serialize room event", exception);
        }
    }

    private static final class RoomState {
        private final Map<UUID, Connection> connections = new LinkedHashMap<>();
        private long nextSequence;
    }

    private record Connection(RoomMembership membership, Consumer<String> outbound) {
    }
}
