package com.signconnect.realtime.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.RoomErrorEvent;
import com.signconnect.realtime.api.RoomJoinEvent;
import com.signconnect.realtime.api.SignerDeniedEvent;
import com.signconnect.realtime.api.SignerReleaseEvent;
import com.signconnect.realtime.api.SignerRequestEvent;
import com.signconnect.realtime.api.LandmarkChunkEvent;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.config.RoomProperties;
import com.signconnect.realtime.inference.InferenceClient;
import com.signconnect.realtime.recognition.RealtimeRecognitionSession;
import com.signconnect.realtime.room.RoomMembership;
import com.signconnect.realtime.room.RoomParticipant;
import com.signconnect.realtime.room.RoomRegistry;
import com.signconnect.realtimecontract.RealtimeTicketCodec;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.socket.CloseStatus;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

import java.time.Clock;
import java.time.Instant;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;

@Component
public class CaptionWebSocketHandler implements WebSocketHandler {

    private static final int CONNECTION_EVENT_QUEUE_CAPACITY = 64;
    private static final UUID UNCORRELATED_REQUEST_ID = new UUID(0L, 0L);

    private final ObjectMapper objectMapper;
    private final RecognitionProperties properties;
    private final InferenceClient inferenceClient;
    private final RoomProperties roomProperties;
    private final RealtimeTicketCodec ticketCodec;
    private final RoomRegistry roomRegistry;
    private final Clock clock;
    private final boolean developmentProfileActive;

    public CaptionWebSocketHandler(
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            RoomProperties roomProperties,
            RealtimeTicketCodec ticketCodec,
            RoomRegistry roomRegistry,
            Clock clock,
            Environment environment) {
        this.objectMapper = objectMapper;
        this.properties = properties;
        this.inferenceClient = inferenceClient;
        this.roomProperties = roomProperties;
        this.ticketCodec = ticketCodec;
        this.roomRegistry = roomRegistry;
        this.clock = clock;
        this.developmentProfileActive = environment.acceptsProfiles(Profiles.of("development"));
    }

    @Override
    public Mono<Void> handle(WebSocketSession session) {
        UUID meetingId = meetingIdFrom(session);
        RealtimeRecognitionSession recognition = new RealtimeRecognitionSession(
                meetingId,
                objectMapper,
                properties,
                inferenceClient,
                clock,
                developmentProfileActive);
        ConnectionEmitter connectionEmitter = new ConnectionEmitter();
        SignerCommandOrder signerCommandOrder = new SignerCommandOrder();
        AtomicReference<RoomMembership> membership = new AtomicReference<>();
        AtomicBoolean cleanedUp = new AtomicBoolean();
        AtomicBoolean invalidated = new AtomicBoolean();
        Runnable invalidateConnection = () -> {
            if (!invalidated.compareAndSet(false, true)) {
                return;
            }
            recognition.close();
            connectionEmitter.complete();
            session.close(new CloseStatus(4002, "Replaced by resumed connection"))
                    .onErrorResume(ignored -> Mono.empty())
                    .subscribe();
        };

        Flux<String> privateRecognitionOutput = recognition.outboundMessages()
                .handle((message, sink) -> {
                    if (!routeFinalCaption(message, membership.get())) {
                        sink.next(message);
                    }
                });

        Mono<Void> receive = session.receive()
                .doOnNext(message -> accept(
                        meetingId,
                        recognition,
                        membership,
                        connectionEmitter,
                        invalidateConnection,
                        signerCommandOrder,
                        message))
                .then()
                .doFinally(ignored -> cleanup(
                        recognition,
                        membership.get(),
                        connectionEmitter,
                        cleanedUp));
        Mono<Void> send = session.send(
                Flux.merge(privateRecognitionOutput, connectionEmitter.messages())
                        .map(session::textMessage));
        return Mono.when(receive, send)
                .doFinally(ignored -> cleanup(
                        recognition,
                        membership.get(),
                        connectionEmitter,
                        cleanedUp));
    }

    private void accept(
            UUID meetingId,
            RealtimeRecognitionSession recognition,
            AtomicReference<RoomMembership> membership,
            ConnectionEmitter connectionEmitter,
            Runnable invalidateConnection,
            SignerCommandOrder signerCommandOrder,
            WebSocketMessage message) {
        if (message.getType() != WebSocketMessage.Type.TEXT) {
            if (membership.get() == null && roomProperties.isRequireJoin()) {
                emitRoomError(meetingId, connectionEmitter, "JOIN_REQUIRED", "Join the room before sending events.");
            } else {
                recognition.acceptNonText();
            }
            return;
        }
        int byteCount = message.getPayload().readableByteCount();
        String text = byteCount > properties.getMaxMessageSize().toBytes()
                ? ""
                : message.getPayloadAsText();

        JsonNode root = readObject(text);
        if (root != null && "room.join".equals(root.path("type").asText())) {
            joinRoom(
                    meetingId,
                    membership,
                    connectionEmitter,
                    invalidateConnection,
                    root);
            return;
        }
        if (roomProperties.isRequireJoin() && membership.get() == null) {
            if (root != null && "signer.request".equals(root.path("type").asText())) {
                emitSignerDenied(
                        meetingId,
                        connectionEmitter,
                        uuidFrom(root, "requestId"),
                        uuidFrom(root, "streamId"),
                        "NOT_JOINED");
            } else {
                emitRoomError(
                        meetingId,
                        connectionEmitter,
                        "JOIN_REQUIRED",
                        "Join the room before sending events.");
            }
            return;
        }

        if (root != null && "signer.request".equals(root.path("type").asText())) {
            requestSigner(meetingId, membership.get(), connectionEmitter, signerCommandOrder, root);
            return;
        }
        if (root != null && "signer.release".equals(root.path("type").asText())) {
            releaseSigner(
                    meetingId,
                    recognition,
                    membership.get(),
                    connectionEmitter,
                    signerCommandOrder,
                    root);
            return;
        }
        UUID recognitionStreamId = root == null ? null : uuidFrom(root, "streamId");
        if (roomProperties.isRequireJoin()
                && root != null
                && requiresSignerOwnership(root)
                && recognitionStreamId != null
                && !roomRegistry.ownsSigner(membership.get(), recognitionStreamId)) {
            roomRegistry.denySigner(
                    membership.get(), UNCORRELATED_REQUEST_ID, recognitionStreamId, "SIGNER_UNAVAILABLE");
            return;
        }
        boolean stopped = recognition.acceptText(text, byteCount);
        if (roomProperties.isRequireJoin()
                && stopped
                && root != null
                && "recognition.control".equals(root.path("type").asText())
                && "stop".equals(root.path("action").asText())) {
            roomRegistry.releaseSigner(
                    membership.get(), uuidFrom(root, "streamId"), "recognition_stopped");
        }
    }

    private void joinRoom(
            UUID meetingId,
            AtomicReference<RoomMembership> membership,
            ConnectionEmitter connectionEmitter,
            Runnable invalidateConnection,
            JsonNode root) {
        if (membership.get() != null) {
            emitRoomError(meetingId, connectionEmitter, "ALREADY_JOINED", "This connection already joined the room.");
            return;
        }
        try {
            RoomJoinEvent join = objectMapper.treeToValue(root, RoomJoinEvent.class);
            if (!join.hasValidContract()) {
                emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
                return;
            }
            RealtimeTicketCodec.Claims claims = join.isResume()
                    ? ticketCodec.verifyResume(join.credential())
                    : ticketCodec.verify(join.credential());
            if (!meetingId.equals(claims.meetingId())) {
                emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
                return;
            }
            Instant resumeExpiresAt = clock.instant().plus(roomProperties.getResumeTicketTtl());
            String resumeToken = ticketCodec.issueResume(new RealtimeTicketCodec.Claims(
                    claims.meetingId(),
                    claims.participantId(),
                    claims.displayName(),
                    claims.role(),
                    resumeExpiresAt));
            RoomParticipant participant = new RoomParticipant(
                    claims.meetingId(),
                    claims.participantId(),
                    claims.displayName(),
                    claims.role());
            RoomMembership joined = join.isResume()
                    ? roomRegistry.resume(
                            participant,
                            connectionEmitter::emit,
                            invalidateConnection,
                            join.credential(),
                            resumeToken,
                            resumeExpiresAt)
                    : roomRegistry.join(
                            participant,
                            connectionEmitter::emit,
                            invalidateConnection,
                            resumeToken,
                            resumeExpiresAt);
            if (!membership.compareAndSet(null, joined)) {
                roomRegistry.leave(joined);
                emitRoomError(meetingId, connectionEmitter, "ALREADY_JOINED", "This connection already joined the room.");
            }
        } catch (RealtimeTicketCodec.InvalidTicketException exception) {
            String code = exception.reason() == RealtimeTicketCodec.InvalidTicketException.Reason.EXPIRED
                    ? "TICKET_EXPIRED"
                    : "INVALID_JOIN";
            emitRoomError(meetingId, connectionEmitter, code, "The room join request was rejected.");
        } catch (IllegalArgumentException exception) {
            emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
        } catch (RoomRegistry.RoomCapacityExceededException exception) {
            emitRoomError(meetingId, connectionEmitter, "ROOM_FULL", "This room has reached its participant limit.");
        } catch (RoomRegistry.ParticipantAlreadyConnectedException exception) {
            emitRoomError(
                    meetingId,
                    connectionEmitter,
                    "PARTICIPANT_CONNECTED",
                    "This participant already has an active room connection.");
        } catch (RoomRegistry.RoomNotFoundException exception) {
            emitRoomError(
                    meetingId,
                    connectionEmitter,
                    "ROOM_NOT_FOUND",
                    "This room no longer exists.");
        } catch (RoomRegistry.InvalidResumeTokenException exception) {
            emitRoomError(
                    meetingId,
                    connectionEmitter,
                    "INVALID_JOIN",
                    "The room join request was rejected.");
        } catch (Exception exception) {
            emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
        }
    }

    private void requestSigner(
            UUID meetingId,
            RoomMembership membership,
            ConnectionEmitter connectionEmitter,
            SignerCommandOrder signerCommandOrder,
            JsonNode root) {
        try {
            SignerRequestEvent request = objectMapper.treeToValue(root, SignerRequestEvent.class);
            if (!request.hasValidContract()
                    || !signerCommandOrder.accept(request.sequence(), request.timestampMs())) {
                emitRoomError(
                        meetingId, connectionEmitter, "INVALID_SIGNER_EVENT", "Signer request was rejected.");
                return;
            }
            roomRegistry.requestSigner(membership, request.requestId(), request.streamId());
        } catch (Exception exception) {
            emitRoomError(
                    meetingId, connectionEmitter, "INVALID_SIGNER_EVENT", "Signer request was rejected.");
        }
    }

    private void releaseSigner(
            UUID meetingId,
            RealtimeRecognitionSession recognition,
            RoomMembership membership,
            ConnectionEmitter connectionEmitter,
            SignerCommandOrder signerCommandOrder,
            JsonNode root) {
        try {
            SignerReleaseEvent release = objectMapper.treeToValue(root, SignerReleaseEvent.class);
            if (!release.hasValidContract()
                    || !signerCommandOrder.accept(release.sequence(), release.timestampMs())) {
                emitRoomError(
                        meetingId, connectionEmitter, "INVALID_SIGNER_EVENT", "Signer release was rejected.");
                return;
            }
            if (roomRegistry.releaseSigner(membership, release.streamId(), release.reason())) {
                recognition.releaseOwnership();
            } else {
                roomRegistry.denySigner(
                        membership,
                        UNCORRELATED_REQUEST_ID,
                        release.streamId(),
                        "SIGNER_UNAVAILABLE");
            }
        } catch (Exception exception) {
            emitRoomError(
                    meetingId, connectionEmitter, "INVALID_SIGNER_EVENT", "Signer release was rejected.");
        }
    }

    private static boolean requiresSignerOwnership(JsonNode root) {
        String type = root.path("type").asText();
        return "landmark.chunk".equals(type) || "recognition.control".equals(type);
    }

    private static UUID uuidFrom(JsonNode root, String field) {
        return root == null ? null : LandmarkChunkEvent.parseCanonicalUuid(root.path(field).asText(null));
    }

    private boolean routeFinalCaption(String message, RoomMembership membership) {
        if (membership == null) {
            return false;
        }
        JsonNode root;
        try {
            root = objectMapper.readTree(message);
        } catch (Exception exception) {
            return false;
        }
        if (root == null || !"caption.final".equals(root.path("type").asText())) {
            return false;
        }
        try {
            roomRegistry.publishCaption(membership, objectMapper.treeToValue(root, CaptionEvent.class));
        } catch (Exception exception) {
            // A shared final must never fall back to connection-private delivery.
        }
        return true;
    }

    private JsonNode readObject(String text) {
        try {
            JsonNode root = objectMapper.readTree(text);
            return root != null && root.isObject() ? root : null;
        } catch (Exception exception) {
            return null;
        }
    }

    private void emitRoomError(
            UUID meetingId,
            ConnectionEmitter connectionEmitter,
            String code,
            String message) {
        try {
            connectionEmitter.emit(objectMapper.writeValueAsString(new RoomErrorEvent(
                    1,
                    "room.error",
                    meetingId,
                    0,
                    new RoomErrorEvent.Payload(code, message),
                    clock.instant())));
        } catch (Exception exception) {
            connectionEmitter.fail();
        }
    }

    private void emitSignerDenied(
            UUID meetingId,
            ConnectionEmitter connectionEmitter,
            UUID requestId,
            UUID streamId,
            String reason) {
        try {
            connectionEmitter.emit(objectMapper.writeValueAsString(new SignerDeniedEvent(
                    1,
                    "signer.denied",
                    meetingId,
                    streamId,
                    0,
                    new SignerDeniedEvent.Payload(
                            requestId == null ? UNCORRELATED_REQUEST_ID : requestId,
                            reason),
                    clock.instant())));
        } catch (Exception exception) {
            connectionEmitter.fail();
        }
    }

    private void cleanup(
            RealtimeRecognitionSession recognition,
            RoomMembership membership,
            ConnectionEmitter connectionEmitter,
            AtomicBoolean cleanedUp) {
        if (!cleanedUp.compareAndSet(false, true)) {
            return;
        }
        roomRegistry.leave(membership);
        recognition.close();
        connectionEmitter.complete();
    }

    private UUID meetingIdFrom(WebSocketSession session) {
        String path = session.getHandshakeInfo().getUri().getPath();
        return UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
    }

    private static final class ConnectionEmitter {
        private final Sinks.Many<String> sink = Sinks.many().unicast()
                .onBackpressureBuffer(new ArrayBlockingQueue<>(CONNECTION_EVENT_QUEUE_CAPACITY));

        synchronized void emit(String message) {
            Sinks.EmitResult result = sink.tryEmitNext(message);
            if (result.isFailure() && result != Sinks.EmitResult.FAIL_CANCELLED) {
                fail();
            }
        }

        synchronized void complete() {
            sink.tryEmitComplete();
        }

        synchronized void fail() {
            sink.tryEmitError(new IllegalStateException("Room output queue is unavailable"));
        }

        Flux<String> messages() {
            return sink.asFlux();
        }
    }

    private static final class SignerCommandOrder {
        private long nextSequence;
        private double lastTimestamp = -1.0;

        synchronized boolean accept(long sequence, double timestampMs) {
            if (sequence != nextSequence || timestampMs <= lastTimestamp) {
                return false;
            }
            nextSequence++;
            lastTimestamp = timestampMs;
            return true;
        }
    }
}
