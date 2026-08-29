package com.signconnect.realtime;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient;
import org.springframework.test.context.ActiveProfiles;
import reactor.core.publisher.Mono;

import java.net.URI;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "signconnect.rooms.require-join=false")
@ActiveProfiles("development")
class RealtimeCaptionApiTest {

    @Value("${local.server.port}")
    private int port;

    @Test
    void publishesFinalCaptionForRecognizerResult() {
        AtomicReference<String> receivedMessage = new AtomicReference<>();
        ReactorNettyWebSocketClient client = new ReactorNettyWebSocketClient();
        URI endpoint = URI.create("ws://localhost:%d/ws/v1/realtime/22222222-2222-4222-8222-222222222222"
                .formatted(port));

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
        assertThat(JsonPath.<Integer>read(response, "$.schemaVersion")).isEqualTo(1);
        assertThat(JsonPath.<String>read(response, "$.type")).isEqualTo("caption.final");
        assertThat(JsonPath.<String>read(response, "$.meetingId"))
                .isEqualTo("22222222-2222-4222-8222-222222222222");
        assertThat(JsonPath.<String>read(response, "$.streamId"))
                .isEqualTo("00000000-0000-4000-8000-000000000000");
        assertThat(JsonPath.<Integer>read(response, "$.sequence")).isZero();
        assertThat(JsonPath.<String>read(response, "$.payload.labelId")).isEqualTo("SIMULATOR");
        assertThat(JsonPath.<String>read(response, "$.payload.text")).isEqualTo("Hello everyone");
        assertThat(JsonPath.<Double>read(response, "$.payload.confidence")).isEqualTo(0.93);
        assertThat(JsonPath.<String>read(response, "$.payload.modelVersion")).isEqualTo("simulator-v1");
        assertThat(JsonPath.<Double>read(response, "$.payload.inferenceLatencyMs")).isZero();
        assertThat(JsonPath.<Boolean>read(response, "$.payload.mockModel")).isTrue();
        assertThat(JsonPath.<String>read(response, "$.occurredAt")).isNotBlank();
    }
}
