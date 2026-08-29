package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "signconnect.recognition.tracking-timeout=50ms",
                "signconnect.recognition.max-message-size=64KB"
        })
class RealtimeRecognitionStartupTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final String MEETING_ID = "22222222-2222-4222-8222-222222222222";

    @Value("${local.server.port}")
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void acceptsFirstChunkAfterBrowserModelStartupThenStartsTrackingTimeout() throws Exception {
        try (WebSocketProbe socket = WebSocketProbe.connect(
                URI.create("ws://localhost:%d/ws/v1/realtime/%s".formatted(port, MEETING_ID)),
                objectMapper,
                WAIT)) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            JsonNode started = socket.awaitEvent(
                    event -> event.path("payload").path("reason").asText().equals("STARTED"), WAIT);
            assertThat(started.path("payload").path("state").asText()).isEqualTo("READY");

            Thread.sleep(100);
            socket.send(RealtimeTestFixtures.fixture("landmark-chunk.valid.json"));

            JsonNode trackingTimeout = socket.awaitEvent(
                    event -> event.path("payload").path("reason").asText().equals("OUT_OF_ORDER"),
                    WAIT);
            assertThat(trackingTimeout.path("payload").path("message").asText())
                    .isEqualTo("Tracking continuity was reset.");
        }
    }
}
