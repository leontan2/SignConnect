package com.signconnect.realtime.web;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.CaptionPayload;
import com.signconnect.realtime.api.RecognitionResultEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Mono;

import java.time.Clock;
import java.time.Instant;

@Component
public class CaptionWebSocketHandler implements WebSocketHandler {

    private final ObjectMapper objectMapper;
    private final Clock clock;

    public CaptionWebSocketHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.clock = Clock.systemUTC();
    }

    @Override
    public Mono<Void> handle(WebSocketSession session) {
        String meetingId = meetingIdFrom(session);

        return session.send(session.receive()
                .filter(message -> message.getType() == WebSocketMessage.Type.TEXT)
                .map(WebSocketMessage::getPayloadAsText)
                .map(message -> createCaption(meetingId, message))
                .map(session::textMessage));
    }

    private String createCaption(String meetingId, String message) {
        try {
            RecognitionResultEvent recognition = objectMapper.readValue(message, RecognitionResultEvent.class);
            CaptionEvent caption = new CaptionEvent(
                    "caption.final",
                    meetingId,
                    recognition.sequence(),
                    new CaptionPayload(recognition.payload().text(), recognition.payload().confidence()),
                    Instant.now(clock)
            );
            return objectMapper.writeValueAsString(caption);
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Invalid recognition event", exception);
        }
    }

    private String meetingIdFrom(WebSocketSession session) {
        String path = session.getHandshakeInfo().getUri().getPath();
        return path.substring(path.lastIndexOf('/') + 1);
    }
}