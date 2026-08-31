package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtimecontract.RealtimeTicketCodec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("development")
class RealtimeRoomWebSocketTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final UUID MEETING_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID OTHER_MEETING_ID = UUID.fromString("99999999-9999-4999-8999-999999999999");
    private static final UUID HOST_ID = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    private static final UUID GUEST_ID = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    @Value("${local.server.port}")
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private RealtimeTicketCodec ticketCodec;

    @Test
    void joinsTwoParticipantsAndBroadcastsOneFinalCaptionWithoutCrossRoomLeakage() throws Exception {
        try (WebSocketProbe host = connect(MEETING_ID);
             WebSocketProbe guest = connect(MEETING_ID);
             WebSocketProbe otherRoom = connect(OTHER_MEETING_ID)) {
            join(host, MEETING_ID, HOST_ID, "Leon", "HOST");
            assertThat(host.awaitEvent(type("room.joined"), WAIT).path("participantId").asText())
                    .isEqualTo(HOST_ID.toString());
            assertThat(host.awaitEvent(type("room.snapshot"), WAIT)
                    .path("payload").path("participants").size()).isEqualTo(1);
            host.awaitEvent(type("participant.joined"), WAIT);

            join(guest, MEETING_ID, GUEST_ID, "Ari", "GUEST");
            guest.awaitEvent(type("room.joined"), WAIT);
            JsonNode guestSnapshot = guest.awaitEvent(type("room.snapshot"), WAIT);
            assertThat(guestSnapshot.path("payload").path("participants").size()).isEqualTo(2);
            guest.awaitEvent(type("participant.joined"), WAIT);
            JsonNode guestPresence = host.awaitEvent(type("participant.joined"), WAIT);
            assertThat(guestPresence.path("participantId").asText()).isEqualTo(GUEST_ID.toString());

            join(otherRoom, OTHER_MEETING_ID, UUID.randomUUID(), "Other", "HOST");
            otherRoom.awaitEvent(type("room.joined"), WAIT);
            otherRoom.awaitEvent(type("room.snapshot"), WAIT);
            otherRoom.awaitEvent(type("participant.joined"), WAIT);

            host.send("""
                    {
                      "schemaVersion": 1,
                      "type": "signer.request",
                      "requestId": "10101010-1010-4010-8010-101010101010",
                      "streamId": "00000000-0000-4000-8000-000000000000",
                      "sequence": 0,
                      "timestampMs": 0
                    }
                    """);
            host.awaitEvent(type("signer.granted"), WAIT);
            host.awaitEvent(type("participant.updated"), WAIT);
            guest.awaitEvent(type("signer.granted"), WAIT);
            guest.awaitEvent(type("participant.updated"), WAIT);

            host.send("""
                    {
                      "type": "recognition.result",
                      "sequence": 7,
                      "payload": {"text": "Hello everyone", "confidence": 0.93}
                    }
                    """);

            JsonNode hostCaption = host.awaitEvent(type("caption.final"), WAIT);
            JsonNode guestCaption = guest.awaitEvent(type("caption.final"), WAIT);

            assertThat(hostCaption).isEqualTo(guestCaption);
            assertThat(hostCaption.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(hostCaption.path("captionId").asText()).isNotBlank();
            assertThat(hostCaption.path("payload").path("sourceDisplayName").asText()).isEqualTo("Leon");
            assertThat(hostCaption.path("payload").path("text").asText()).isEqualTo("Hello everyone");
            assertThat(otherRoom.pollEvent(Duration.ofMillis(200))).isNull();

            host.send("""
                    {
                      "schemaVersion": 1,
                      "type": "signer.release",
                      "streamId": "00000000-0000-4000-8000-000000000000",
                      "sequence": 1,
                      "timestampMs": 40,
                      "reason": "user_request"
                    }
                    """);
            host.awaitEvent(type("signer.released"), WAIT);
            host.awaitEvent(type("participant.updated"), WAIT);
            guest.awaitEvent(type("signer.released"), WAIT);
            guest.awaitEvent(type("participant.updated"), WAIT);

            host.send("""
                    {
                      "schemaVersion": 1,
                      "type": "signer.request",
                      "requestId": "20202020-2020-4020-8020-202020202020",
                      "streamId": "11111111-1111-4111-8111-111111111111",
                      "sequence": 2,
                      "timestampMs": 80
                    }
                    """);
            host.awaitEvent(type("signer.granted"), WAIT);
            host.awaitEvent(type("participant.updated"), WAIT);
            guest.awaitEvent(type("signer.granted"), WAIT);
            guest.awaitEvent(type("participant.updated"), WAIT);

            host.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            host.awaitEvent(event -> "STARTED".equals(event.path("payload").path("reason").asText()), WAIT);
            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();

            host.send(RealtimeTestFixtures.fixture("landmark-chunk.valid.json"));
            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    @Test
    void rejectsApplicationEventsBeforeAValidRoomJoin() {
        try (WebSocketProbe socket = connect(MEETING_ID)) {
            socket.send("""
                    {
                      "type": "recognition.result",
                      "sequence": 1,
                      "payload": {"text": "Must not pass", "confidence": 0.99}
                    }
                    """);

            JsonNode error = socket.awaitEvent(type("room.error"), WAIT);
            assertThat(error.path("payload").path("code").asText()).isEqualTo("JOIN_REQUIRED");
            assertThat(error.toString()).doesNotContain("Must not pass");
        }
    }

    @Test
    void broadcastsOneAttributedChatMessageWithoutCrossRoomLeakage() throws Exception {
        UUID messageId = UUID.fromString("33333333-3333-4333-8333-333333333333");
        try (WebSocketProbe host = connect(MEETING_ID);
             WebSocketProbe guest = connect(MEETING_ID);
             WebSocketProbe otherRoom = connect(OTHER_MEETING_ID)) {
            join(host, MEETING_ID, HOST_ID, "Leon", "HOST");
            host.awaitEvent(type("room.joined"), WAIT);
            host.awaitEvent(type("room.snapshot"), WAIT);
            host.awaitEvent(type("participant.joined"), WAIT);

            join(guest, MEETING_ID, GUEST_ID, "Ari", "GUEST");
            guest.awaitEvent(type("room.joined"), WAIT);
            guest.awaitEvent(type("room.snapshot"), WAIT);
            guest.awaitEvent(type("participant.joined"), WAIT);
            host.awaitEvent(type("participant.joined"), WAIT);

            join(otherRoom, OTHER_MEETING_ID, UUID.randomUUID(), "Other", "HOST");
            otherRoom.awaitEvent(type("room.joined"), WAIT);
            otherRoom.awaitEvent(type("room.snapshot"), WAIT);
            otherRoom.awaitEvent(type("participant.joined"), WAIT);

            String message = """
                    {
                      "schemaVersion": 1,
                      "type": "chat.message",
                      "messageId": "%s",
                      "text": "Can you repeat that sign?"
                    }
                    """.formatted(messageId);
            host.send(message);

            JsonNode hostMessage = host.awaitEvent(type("chat.message"), WAIT);
            JsonNode guestMessage = guest.awaitEvent(type("chat.message"), WAIT);
            assertThat(hostMessage).isEqualTo(guestMessage);
            assertThat(hostMessage.path("messageId").asText()).isEqualTo(messageId.toString());
            assertThat(hostMessage.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(hostMessage.path("payload").path("sourceDisplayName").asText()).isEqualTo("Leon");
            assertThat(hostMessage.path("payload").path("text").asText()).isEqualTo("Can you repeat that sign?");
            assertThat(hostMessage.path("sequence").asLong()).isPositive();
            assertThat(otherRoom.pollEvent(Duration.ofMillis(200))).isNull();

            host.send(message);
            assertThat(host.pollEvent(Duration.ofMillis(200))).isNull();
            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    @Test
    void routesACallOfferOnlyToTheTargetParticipantAndSuppressesDuplicates() throws Exception {
        UUID observerId = UUID.fromString("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
        UUID signalId = UUID.fromString("44444444-4444-4444-8444-444444444444");
        UUID callId = UUID.fromString("55555555-5555-4555-8555-555555555555");
        try (WebSocketProbe host = connect(MEETING_ID);
             WebSocketProbe guest = connect(MEETING_ID);
             WebSocketProbe observer = connect(MEETING_ID)) {
            join(host, MEETING_ID, HOST_ID, "Leon", "HOST");
            host.awaitEvent(type("room.joined"), WAIT);
            host.awaitEvent(type("room.snapshot"), WAIT);
            host.awaitEvent(type("participant.joined"), WAIT);

            join(guest, MEETING_ID, GUEST_ID, "Ari", "GUEST");
            guest.awaitEvent(type("room.joined"), WAIT);
            guest.awaitEvent(type("room.snapshot"), WAIT);
            guest.awaitEvent(type("participant.joined"), WAIT);
            host.awaitEvent(type("participant.joined"), WAIT);

            join(observer, MEETING_ID, observerId, "Observer", "GUEST");
            observer.awaitEvent(type("room.joined"), WAIT);
            observer.awaitEvent(type("room.snapshot"), WAIT);
            observer.awaitEvent(type("participant.joined"), WAIT);
            host.awaitEvent(type("participant.joined"), WAIT);
            guest.awaitEvent(type("participant.joined"), WAIT);

            String offer = """
                    {
                      "schemaVersion": 1,
                      "type": "call.offer",
                      "signalId": "%s",
                      "callId": "%s",
                      "targetParticipantId": "%s",
                      "payload": {"sdp": "v=0\\r\\no=host"}
                    }
                    """.formatted(signalId, callId, GUEST_ID);
            host.send(offer);

            JsonNode delivered = guest.awaitEvent(type("call.offer"), WAIT);
            assertThat(delivered.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(delivered.path("targetParticipantId").asText()).isEqualTo(GUEST_ID.toString());
            assertThat(delivered.path("signalId").asText()).isEqualTo(signalId.toString());
            assertThat(delivered.path("callId").asText()).isEqualTo(callId.toString());
            assertThat(delivered.path("payload").path("sdp").asText()).isEqualTo("v=0\r\no=host");
            assertThat(host.pollEvent(Duration.ofMillis(200))).isNull();
            assertThat(observer.pollEvent(Duration.ofMillis(200))).isNull();

            host.send(offer);
            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    private WebSocketProbe connect(UUID meetingId) {
        return WebSocketProbe.connect(
                URI.create("ws://localhost:%d/ws/v1/realtime/%s".formatted(port, meetingId)),
                objectMapper,
                WAIT);
    }

    private void join(
            WebSocketProbe socket,
            UUID meetingId,
            UUID participantId,
            String displayName,
            String role) throws Exception {
        String ticket = ticketCodec.issue(new RealtimeTicketCodec.Claims(
                meetingId,
                participantId,
                displayName,
                role,
                Instant.now().plusSeconds(300)));
        socket.send(objectMapper.writeValueAsString(new JoinCommand(1, "room.join", ticket)));
    }

    private static java.util.function.Predicate<JsonNode> type(String type) {
        return event -> type.equals(event.path("type").asText());
    }

    private record JoinCommand(int schemaVersion, String type, String ticket) {
    }
}
