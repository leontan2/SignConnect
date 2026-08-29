package com.signconnect.realtime;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient;
import reactor.core.publisher.Mono;

import java.net.URI;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RealtimeCaptionApiTest {

    @Value("${local.server.port}")
    private int port;

    @Test
    void publishesFinalCaptionForRecognizerResult() {
        AtomicReference<String> receivedMessage = new AtomicReference<>();
        ReactorNettyWebSocketClient client = new ReactorNettyWebSocketClient();
        URI endpoint = URI.create("ws://localhost:%d/ws/v1/realtime/meeting-123".formatted(port));

        client.execute(endpoint, session -> session
                        .send(Mono.just(session.textMessage("""
                                {
                                  "type": "recognition.result",
                                  "sequence": 7,
                                  "payload": {
                                    "text": "Hello everyone",
                                    "confidence": 0.93
                                  }
                                }
                                """)))
                        .thenMany(session.receive().take(1))
                        .doOnNext(message -> receivedMessage.set(message.getPayloadAsText()))
                        .then())
                .block(Duration.ofSeconds(5));

        String response = receivedMessage.get();
        assertThat(response).isNotNull();
        assertThat(JsonPath.<String>read(response, "$.type")).isEqualTo("caption.final");
        assertThat(JsonPath.<String>read(response, "$.meetingId")).isEqualTo("meeting-123");
        assertThat(JsonPath.<Integer>read(response, "$.sequence")).isEqualTo(7);
        assertThat(JsonPath.<String>read(response, "$.payload.text")).isEqualTo("Hello everyone");
        assertThat(JsonPath.<Double>read(response, "$.payload.confidence")).isEqualTo(0.93);
        assertThat(JsonPath.<String>read(response, "$.occurredAt")).isNotBlank();
    }
}