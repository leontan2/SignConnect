package com.signconnect.realtime.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.inference.InferenceClient;
import com.signconnect.realtime.recognition.RealtimeRecognitionSession;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.socket.WebSocketHandler;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import reactor.core.publisher.Mono;

import java.time.Clock;
import java.util.UUID;

@Component
public class CaptionWebSocketHandler implements WebSocketHandler {

    private final ObjectMapper objectMapper;
    private final RecognitionProperties properties;
    private final InferenceClient inferenceClient;
    private final Clock clock;
    private final boolean developmentProfileActive;

    public CaptionWebSocketHandler(
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            Clock clock,
            Environment environment) {
        this.objectMapper = objectMapper;
        this.properties = properties;
        this.inferenceClient = inferenceClient;
        this.clock = clock;
        this.developmentProfileActive = environment.acceptsProfiles(Profiles.of("development"));
    }

    @Override
    public Mono<Void> handle(WebSocketSession session) {
        RealtimeRecognitionSession recognition = new RealtimeRecognitionSession(
                meetingIdFrom(session),
                objectMapper,
                properties,
                inferenceClient,
                clock,
                developmentProfileActive);

        Mono<Void> receive = session.receive()
                .doOnNext(message -> accept(recognition, message))
                .then()
                .doFinally(ignored -> recognition.close());
        Mono<Void> send = session.send(
                recognition.outboundMessages().map(session::textMessage));
        return Mono.when(receive, send);
    }

    private void accept(RealtimeRecognitionSession recognition, WebSocketMessage message) {
        if (message.getType() != WebSocketMessage.Type.TEXT) {
            recognition.acceptNonText();
            return;
        }
        int byteCount = message.getPayload().readableByteCount();
        String text = byteCount > properties.getMaxMessageSize().toBytes()
                ? ""
                : message.getPayloadAsText();
        recognition.acceptText(text, byteCount);
    }

    private UUID meetingIdFrom(WebSocketSession session) {
        String path = session.getHandshakeInfo().getUri().getPath();
        return UUID.fromString(path.substring(path.lastIndexOf('/') + 1));
    }
}
