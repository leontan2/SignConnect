package com.signconnect.realtime.room;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.ParticipantPresenceEvent;
import com.signconnect.realtime.api.RoomCaptionEvent;
import com.signconnect.realtime.api.RoomJoinedEvent;
import com.signconnect.realtime.api.RoomSnapshotEvent;
import com.signconnect.realtime.api.SignerDeniedEvent;
import com.signconnect.realtime.api.SignerGrantedEvent;
import com.signconnect.realtime.api.SignerReleasedEvent;
import com.signconnect.realtime.config.RoomProperties;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

@Component
public class InMemoryRoomRegistry implements RoomRegistry {

    private static final int MAX_REMEMBERED_CAPTION_IDS = 4096;

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
        if (properties.getResumeTicketTtl() == null
                || properties.getResumeTicketTtl().isZero()
                || properties.getResumeTicketTtl().isNegative()
                || properties.getResumeTicketTtl().compareTo(java.time.Duration.ofHours(1)) > 0) {
            throw new IllegalArgumentException("Resume ticket TTL must be between 1 millisecond and 1 hour");
        }
        this.maxParticipants = properties.getMaxParticipants();
    }

    @Override
    public RoomMembership join(
            RoomParticipant participant,
            Consumer<String> outbound,
            Runnable invalidateConnection,
            String resumeToken,
            Instant resumeExpiresAt) {
        while (true) {
            RoomState room = rooms.computeIfAbsent(participant.meetingId(), ignored -> new RoomState());
            synchronized (room) {
                // An empty room may have been removed while this join waited for its lock.
                // Retry against the currently registered state rather than reviving a tombstone.
                if (rooms.get(participant.meetingId()) != room) {
                    continue;
                }
                return joinLocked(
                        room,
                        participant,
                        outbound,
                        invalidateConnection,
                        resumeToken,
                        resumeExpiresAt,
                        false);
            }
        }
    }

    @Override
    public RoomMembership resume(
            RoomParticipant participant,
            Consumer<String> outbound,
            Runnable invalidateConnection,
            String presentedResumeToken,
            String rotatedResumeToken,
            Instant resumeExpiresAt) {
        while (true) {
            RoomState room = rooms.get(participant.meetingId());
            if (room == null) {
                throw new RoomNotFoundException();
            }
            synchronized (room) {
                if (rooms.get(participant.meetingId()) != room) {
                    continue;
                }
                pruneExpiredResumeCredentials(room);
                ResumeCredential current = room.resumeCredentials.get(participant.participantId());
                if (current == null || !current.matches(presentedResumeToken, clock.instant())) {
                    throw new InvalidResumeTokenException();
                }
                return joinLocked(
                        room,
                        participant,
                        outbound,
                        invalidateConnection,
                        rotatedResumeToken,
                        resumeExpiresAt,
                        true);
            }
        }
    }

    private RoomMembership joinLocked(
            RoomState room,
            RoomParticipant participant,
            Consumer<String> outbound,
            Runnable invalidateConnection,
            String resumeToken,
            Instant resumeExpiresAt,
            boolean resume) {
        if (outbound == null
                || invalidateConnection == null
                || resumeToken == null
                || resumeToken.isBlank()
                || resumeExpiresAt == null
                || !resumeExpiresAt.isAfter(clock.instant())) {
            throw new IllegalArgumentException("Room connection metadata is invalid");
        }
        pruneExpiredResumeCredentials(room);
        Connection existingConnection = room.connections.values().stream()
                .filter(connection -> connection.membership().participant().participantId()
                        .equals(participant.participantId()))
                .findFirst()
                .orElse(null);
        boolean replacing = resume && existingConnection != null;
        if (existingConnection != null && !replacing) {
            throw new ParticipantAlreadyConnectedException();
        }
        if (!replacing && room.connections.size() >= maxParticipants) {
            throw new RoomCapacityExceededException();
        }
        if (replacing) {
            RoomMembership replacedMembership = existingConnection.membership();
            room.connections.remove(replacedMembership.connectionId());
            existingConnection.invalidateConnection().run();
            if (room.activeSigner != null
                    && room.activeSigner.membership().equals(replacedMembership)) {
                releaseActiveSigner(room, "disconnected");
            }
        }

        RoomMembership membership = new RoomMembership(UUID.randomUUID(), participant);
        room.resumeCredentials.put(
                participant.participantId(),
                new ResumeCredential(resumeTokenFingerprint(resumeToken), resumeExpiresAt));
        room.connections.put(
                membership.connectionId(),
                new Connection(membership, outbound, invalidateConnection));
        Instant now = clock.instant();
        long publicBaseline = room.nextSequence - 1;
        outbound.accept(serialize(new RoomJoinedEvent(
                1,
                "room.joined",
                participant.meetingId(),
                participant.participantId(),
                publicBaseline,
                resumeToken,
                resumeExpiresAt,
                new RoomJoinedEvent.Payload(participant.displayName(), participant.role(), false),
                now)));
        outbound.accept(serialize(new RoomSnapshotEvent(
                1,
                "room.snapshot",
                participant.meetingId(),
                publicBaseline,
                new RoomSnapshotEvent.Payload(snapshot(room)),
                now)));
        if (!replacing) {
            broadcast(room, serialize(new ParticipantPresenceEvent(
                    1,
                    "participant.joined",
                    participant.meetingId(),
                    participant.participantId(),
                    room.nextSequence++,
                    participantPayload(participant, false),
                    now)));
        }
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
        synchronized (room) {
            Connection removed = room.connections.remove(membership.connectionId());
            if (removed == null || !removed.membership().equals(membership)) {
                return;
            }
            if (room.activeSigner != null && room.activeSigner.membership().equals(membership)) {
                releaseActiveSigner(room, "disconnected");
            }
            if (room.connections.isEmpty()) {
                rooms.remove(membership.participant().meetingId(), room);
                return;
            }
            broadcast(room, serialize(new ParticipantPresenceEvent(
                    1,
                    "participant.left",
                    membership.participant().meetingId(),
                    membership.participant().participantId(),
                    room.nextSequence++,
                    participantPayload(membership.participant(), false),
                    clock.instant())));
        }
    }

    @Override
    public void publishCaption(RoomMembership source, CaptionEvent caption) {
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return;
        }
        synchronized (room) {
            if (!activeConnection(room, source)
                    || room.activeSigner == null
                    || !room.activeSigner.membership().equals(source)
                    || !room.activeSigner.streamId().equals(caption.streamId())) {
                return;
            }
            UUID captionId = stableCaptionId(source, caption);
            if (!rememberCaption(room, captionId)) {
                return;
            }
            broadcast(room, serialize(new RoomCaptionEvent(
                    1,
                    "caption.final",
                    source.participant().meetingId(),
                    source.participant().participantId(),
                    captionId,
                    caption.streamId(),
                    room.nextSequence++,
                    RoomCaptionEvent.Payload.from(caption.payload(), source.participant().displayName()),
                    caption.occurredAt())));
        }
    }

    @Override
    public void requestSigner(RoomMembership source, UUID requestId, UUID streamId) {
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return;
        }
        synchronized (room) {
            if (!activeConnection(room, source)) {
                return;
            }
            if (room.activeSigner == null) {
                room.activeSigner = new ActiveSigner(source, requestId, streamId);
                broadcast(room, serialize(new SignerGrantedEvent(
                        1,
                        "signer.granted",
                        source.participant().meetingId(),
                        source.participant().participantId(),
                        room.nextSequence++,
                        new SignerGrantedEvent.Payload(requestId, streamId),
                        clock.instant())));
                broadcastParticipantUpdated(room, source.participant(), true);
                return;
            }
            if (room.activeSigner.membership().equals(source)
                    && room.activeSigner.requestId().equals(requestId)
                    && room.activeSigner.streamId().equals(streamId)) {
                return;
            }
            denySignerLocked(
                    room,
                    source,
                    requestId,
                    streamId,
                    room.activeSigner.membership().equals(source)
                            ? "ALREADY_ACTIVE"
                            : "SIGNER_UNAVAILABLE");
        }
    }

    @Override
    public void denySigner(RoomMembership source, UUID requestId, UUID streamId, String reason) {
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return;
        }
        synchronized (room) {
            if (activeConnection(room, source)) {
                denySignerLocked(room, source, requestId, streamId, reason);
            }
        }
    }

    @Override
    public boolean releaseSigner(RoomMembership source, UUID streamId, String reason) {
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return false;
        }
        synchronized (room) {
            if (!activeConnection(room, source)
                    || room.activeSigner == null
                    || !room.activeSigner.membership().equals(source)
                    || !room.activeSigner.streamId().equals(streamId)) {
                return false;
            }
            releaseActiveSigner(room, reason);
            return true;
        }
    }

    @Override
    public boolean ownsSigner(RoomMembership source, UUID streamId) {
        if (source == null || streamId == null) {
            return false;
        }
        RoomState room = rooms.get(source.participant().meetingId());
        if (room == null) {
            return false;
        }
        synchronized (room) {
            return activeConnection(room, source)
                    && room.activeSigner != null
                    && room.activeSigner.membership().equals(source)
                    && room.activeSigner.streamId().equals(streamId);
        }
    }

    private void releaseActiveSigner(RoomState room, String reason) {
        ActiveSigner released = room.activeSigner;
        room.activeSigner = null;
        RoomParticipant participant = released.membership().participant();
        broadcast(room, serialize(new SignerReleasedEvent(
                1,
                "signer.released",
                participant.meetingId(),
                participant.participantId(),
                room.nextSequence++,
                new SignerReleasedEvent.Payload(
                        released.requestId(), released.streamId(), reason),
                clock.instant())));
        broadcastParticipantUpdated(room, participant, false);
    }

    private void broadcastParticipantUpdated(
            RoomState room,
            RoomParticipant participant,
            boolean activeSigner) {
        broadcast(room, serialize(new ParticipantPresenceEvent(
                1,
                "participant.updated",
                participant.meetingId(),
                participant.participantId(),
                room.nextSequence++,
                participantPayload(participant, activeSigner),
                clock.instant())));
    }

    private void denySignerLocked(
            RoomState room,
            RoomMembership source,
            UUID requestId,
            UUID streamId,
            String reason) {
        Connection connection = room.connections.get(source.connectionId());
        if (connection == null) {
            return;
        }
        connection.outbound().accept(serialize(new SignerDeniedEvent(
                1,
                "signer.denied",
                source.participant().meetingId(),
                streamId,
                room.nextSequence - 1,
                new SignerDeniedEvent.Payload(requestId, reason),
                clock.instant())));
    }

    private static boolean activeConnection(RoomState room, RoomMembership source) {
        Connection active = room.connections.get(source.connectionId());
        return active != null && active.membership().equals(source);
    }

    private static boolean rememberCaption(RoomState room, UUID captionId) {
        if (!room.emittedCaptionIds.add(captionId)) {
            return false;
        }
        if (room.emittedCaptionIds.size() > MAX_REMEMBERED_CAPTION_IDS) {
            Iterator<UUID> oldest = room.emittedCaptionIds.iterator();
            oldest.next();
            oldest.remove();
        }
        return true;
    }

    private static ParticipantPresenceEvent.Payload participantPayload(
            RoomParticipant participant,
            boolean activeSigner) {
        return new ParticipantPresenceEvent.Payload(
                participant.displayName(), participant.role(), activeSigner);
    }

    private static List<RoomSnapshotEvent.Participant> snapshot(RoomState room) {
        return room.connections.values().stream()
                .map(Connection::membership)
                .sorted(Comparator.comparing((RoomMembership item) -> item.participant().displayName())
                        .thenComparing(item -> item.participant().participantId().toString()))
                .map(item -> new RoomSnapshotEvent.Participant(
                        item.participant().participantId(),
                        item.participant().displayName(),
                        item.participant().role(),
                        room.activeSigner != null && room.activeSigner.membership().equals(item)))
                .toList();
    }

    private static UUID stableCaptionId(RoomMembership source, CaptionEvent caption) {
        String value = String.join("|",
                source.participant().meetingId().toString(),
                source.participant().participantId().toString(),
                caption.streamId().toString(),
                Long.toString(caption.sequence()));
        return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void broadcast(RoomState room, String event) {
        new ArrayList<>(room.connections.values())
                .forEach(connection -> connection.outbound().accept(event));
    }

    private void pruneExpiredResumeCredentials(RoomState room) {
        Instant now = clock.instant();
        room.resumeCredentials.entrySet().removeIf(entry -> !entry.getValue().expiresAt().isAfter(now));
    }

    private static byte[] resumeTokenFingerprint(String token) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
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
        private final Map<UUID, ResumeCredential> resumeCredentials = new LinkedHashMap<>();
        private final Set<UUID> emittedCaptionIds = new LinkedHashSet<>();
        private long nextSequence = 1;
        private ActiveSigner activeSigner;
    }

    private record Connection(
            RoomMembership membership,
            Consumer<String> outbound,
            Runnable invalidateConnection) {
    }

    private record ActiveSigner(RoomMembership membership, UUID requestId, UUID streamId) {
    }

    private record ResumeCredential(byte[] fingerprint, Instant expiresAt) {
        private boolean matches(String token, Instant now) {
            return token != null
                    && !token.isBlank()
                    && expiresAt.isAfter(now)
                    && MessageDigest.isEqual(fingerprint, resumeTokenFingerprint(token));
        }
    }
}
