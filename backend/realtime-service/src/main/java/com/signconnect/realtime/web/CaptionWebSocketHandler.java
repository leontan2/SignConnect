package com.signconnect.realtime.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.RoomErrorEvent;
import com.signconnect.realtime.api.RoomJoinEvent;
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
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

import java.time.Clock;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;

@Component
public class CaptionWebSocketHandler implements WebSocketHandler {

    private static final int CONNECTION_EVENT_QUEUE_CAPACITY = 64;

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
        AtomicReference<RoomMembership> membership = new AtomicReference<>();
        AtomicBoolean cleanedUp = new AtomicBoolean();

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
        return Mono.when(receive, send);
    }

    private void accept(
            UUID meetingId,
            RealtimeRecognitionSession recognition,
            AtomicReference<RoomMembership> membership,
            ConnectionEmitter connectionEmitter,
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
            joinRoom(meetingId, membership, connectionEmitter, root);
            return;
        }
        if (roomProperties.isRequireJoin() && membership.get() == null) {
            emitRoomError(meetingId, connectionEmitter, "JOIN_REQUIRED", "Join the room before sending events.");
            return;
        }
        recognition.acceptText(text, byteCount);
    }

    private void joinRoom(
            UUID meetingId,
            AtomicReference<RoomMembership> membership,
            ConnectionEmitter connectionEmitter,
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
            RealtimeTicketCodec.Claims claims = ticketCodec.verify(join.ticket());
            if (!meetingId.equals(claims.meetingId())) {
                emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
                return;
            }
            RoomMembership joined = roomRegistry.join(
                    new RoomParticipant(
                            claims.meetingId(),
                            claims.participantId(),
                            claims.displayName(),
                            claims.role()),
                    connectionEmitter::emit);
            if (!membership.compareAndSet(null, joined)) {
                roomRegistry.leave(joined);
                emitRoomError(meetingId, connectionEmitter, "ALREADY_JOINED", "This connection already joined the room.");
            }
        } catch (IllegalArgumentException exception) {
            emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
        } catch (RoomRegistry.RoomCapacityExceededException exception) {
            emitRoomError(meetingId, connectionEmitter, "ROOM_FULL", "This room has reached its participant limit.");
        } catch (Exception exception) {
            emitRoomError(meetingId, connectionEmitter, "INVALID_JOIN", "The room join request was rejected.");
        }
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
}
