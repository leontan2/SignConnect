package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "signconnect.recognition.simulator-enabled=true")
@ActiveProfiles("test")
class RealtimeSimulatorProfileGateTest {

    @Value("${local.server.port}")
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void propertyOverrideCannotEnableSimulatorOutsideDevelopmentProfile() {
        URI endpoint = URI.create("ws://localhost:%d/ws/v1/realtime/22222222-2222-4222-8222-222222222222"
                .formatted(port));
        try (WebSocketProbe socket = WebSocketProbe.connect(endpoint, objectMapper, Duration.ofSeconds(5))) {
            socket.send("""
                    {
                      "type": "recognition.result",
                      "sequence": 7,
                      "payload": {"text": "Must be rejected", "confidence": 0.93}
                    }
                    """);

            JsonNode response = socket.awaitEvent(
                    event -> "INVALID_EVENT".equals(event.path("payload").path("reason").asText()),
                    Duration.ofSeconds(5));
            assertThat(response.path("type").asText()).isEqualTo("recognition.status");
            assertThat(response.path("payload").path("state").asText()).isEqualTo("INVALID_INPUT");
        }
    }
}
