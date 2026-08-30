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
class RealtimeRoomReliabilityWebSocketTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final UUID MEETING_ID = UUID.fromString("23232323-2323-4232-8232-232323232323");
    private static final UUID ABSENT_MEETING_ID = UUID.fromString("24242424-2424-4242-8242-242424242424");
    private static final UUID HOST_ID = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    private static final UUID GUEST_ID = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2");
    private static final UUID HOST_REQUEST_ID = UUID.fromString("10000000-0000-4000-8000-000000000001");
    private static final UUID GUEST_REQUEST_ID = UUID.fromString("20000000-0000-4000-8000-000000000002");
    private static final UUID HOST_STREAM_ID = UUID.fromString("30000000-0000-4000-8000-000000000003");
    private static final UUID GUEST_STREAM_ID = UUID.fromString("40000000-0000-4000-8000-000000000004");
    private static final UUID RECONNECTED_STREAM_ID = UUID.fromString("50000000-0000-4000-8000-000000000005");

    @Value("${local.server.port}")
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private RealtimeTicketCodec ticketCodec;

    @Test
    void rejectsAResumeTokenWhenItsRoomNoLongerExists() throws Exception {
        String resumeToken = ticketCodec.issueResume(new RealtimeTicketCodec.Claims(
                ABSENT_MEETING_ID,
                HOST_ID,
                "Leon",
                "HOST",
                Instant.now().plusSeconds(300)));

        try (WebSocketProbe resumed = connect(ABSENT_MEETING_ID)) {
            resumed.send(objectMapper.writeValueAsString(
                    new ResumeJoinCommand(1, "room.join", resumeToken)));

            JsonNode error = resumed.awaitEvent(type("room.error"), WAIT);
            assertThat(error.path("payload").path("code").asText()).isEqualTo("ROOM_NOT_FOUND");
            assertThat(resumed.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    @Test
    void grantsOneSignerAndRejectsAnotherParticipantsRecognitionUpload() throws Exception {
        try (WebSocketProbe host = connect(); WebSocketProbe guest = connect()) {
            Joined hostJoined = joinWithTicket(host, HOST_ID, "Leon", "HOST");
            assertThat(hostJoined.resumeToken()).isNotBlank();
            assertThat(hostJoined.resumeExpiresAt()).isNotBlank();

            joinWithTicket(guest, GUEST_ID, "Ari", "GUEST");
            host.awaitEvent(type("participant.joined"), WAIT);

            host.send(signerRequest(HOST_REQUEST_ID, HOST_STREAM_ID, 0));
            JsonNode hostGranted = host.awaitEvent(type("signer.granted"), WAIT);
            JsonNode guestGranted = guest.awaitEvent(type("signer.granted"), WAIT);
            assertThat(hostGranted).isEqualTo(guestGranted);
            assertThat(hostGranted.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(hostGranted.path("payload").path("requestId").asText())
                    .isEqualTo(HOST_REQUEST_ID.toString());
            assertThat(hostGranted.path("payload").path("streamId").asText())
                    .isEqualTo(HOST_STREAM_ID.toString());

            JsonNode hostUpdated = host.awaitEvent(type("participant.updated"), WAIT);
            JsonNode guestUpdated = guest.awaitEvent(type("participant.updated"), WAIT);
            assertThat(hostUpdated).isEqualTo(guestUpdated);
            assertThat(hostUpdated.path("payload").path("activeSigner").asBoolean()).isTrue();
            assertThat(hostUpdated.path("sequence").asLong())
                    .isGreaterThan(hostGranted.path("sequence").asLong());

            guest.send(signerRequest(GUEST_REQUEST_ID, GUEST_STREAM_ID, 0));
            JsonNode denied = guest.awaitEvent(type("signer.denied"), WAIT);
            assertThat(denied.path("streamId").asText()).isEqualTo(GUEST_STREAM_ID.toString());
            assertThat(denied.path("payload").path("requestId").asText())
                    .isEqualTo(GUEST_REQUEST_ID.toString());
            assertThat(denied.path("payload").path("reason").asText()).isEqualTo("SIGNER_UNAVAILABLE");
            assertThat(host.pollEvent(Duration.ofMillis(200))).isNull();

            guest.send(landmarkChunkFor(GUEST_STREAM_ID));
            JsonNode uploadDenied = guest.awaitEvent(type("signer.denied"), WAIT);
            assertThat(uploadDenied.path("payload").path("reason").asText())
                    .isEqualTo("SIGNER_UNAVAILABLE");
            assertThat(host.pollEvent(Duration.ofMillis(200))).isNull();

            host.send(recognitionControl(HOST_STREAM_ID, 0, "start"));
            JsonNode started = host.awaitEvent(event -> "STARTED".equals(
                    event.path("payload").path("reason").asText()), WAIT);
            assertThat(started.path("streamId").asText()).isEqualTo(HOST_STREAM_ID.toString());
            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    @Test
    void reconnectsWithResumeTokenUsingSameIdentityAndRequiresAFreshRecognitionStream() throws Exception {
        try (WebSocketProbe guest = connect()) {
            joinWithTicket(guest, GUEST_ID, "Ari", "GUEST");

            String resumeToken;
            WebSocketProbe host = connect();
            try {
                Joined joined = joinWithTicket(host, HOST_ID, "Leon", "HOST");
                resumeToken = joined.resumeToken();
                guest.awaitEvent(type("participant.joined"), WAIT);

                host.send(signerRequest(HOST_REQUEST_ID, HOST_STREAM_ID, 0));
                host.awaitEvent(type("signer.granted"), WAIT);
                host.awaitEvent(type("participant.updated"), WAIT);
                guest.awaitEvent(type("signer.granted"), WAIT);
                guest.awaitEvent(type("participant.updated"), WAIT);
            } finally {
                host.close();
            }

            JsonNode released = guest.awaitEvent(type("signer.released"), WAIT);
            assertThat(released.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(released.path("payload").path("requestId").asText())
                    .isEqualTo(HOST_REQUEST_ID.toString());
            assertThat(released.path("payload").path("streamId").asText())
                    .isEqualTo(HOST_STREAM_ID.toString());
            assertThat(released.path("payload").path("reason").asText()).isEqualTo("disconnected");
            JsonNode updated = guest.awaitEvent(type("participant.updated"), WAIT);
            assertThat(updated.path("payload").path("activeSigner").asBoolean()).isFalse();
            guest.awaitEvent(type("participant.left"), WAIT);

            try (WebSocketProbe resumed = connect()) {
                resumed.send(objectMapper.writeValueAsString(
                        new ResumeJoinCommand(1, "room.join", resumeToken)));
                JsonNode joined = resumed.awaitEvent(type("room.joined"), WAIT);
                assertThat(joined.path("participantId").asText()).isEqualTo(HOST_ID.toString());
                assertThat(joined.path("resumeToken").asText()).isNotBlank();
                resumed.awaitEvent(type("room.snapshot"), WAIT);
                resumed.awaitEvent(type("participant.joined"), WAIT);
                guest.awaitEvent(type("participant.joined"), WAIT);

                resumed.send(recognitionControl(HOST_STREAM_ID, 0, "start"));
                JsonNode staleDenied = resumed.awaitEvent(type("signer.denied"), WAIT);
                assertThat(staleDenied.path("payload").path("reason").asText())
                        .isEqualTo("SIGNER_UNAVAILABLE");

                resumed.send(signerRequest(UUID.randomUUID(), RECONNECTED_STREAM_ID, 0));
                JsonNode freshGrant = resumed.awaitEvent(type("signer.granted"), WAIT);
                assertThat(freshGrant.path("payload").path("streamId").asText())
                        .isEqualTo(RECONNECTED_STREAM_ID.toString());
            }
        }
    }

    @Test
    void resumeAtomicallyClosesTheOldSocketBeforeTheReplacementReturns() throws Exception {
        try (WebSocketProbe guest = connect();
             WebSocketProbe original = connect();
             WebSocketProbe replacement = connect()) {
            joinWithTicket(guest, GUEST_ID, "Ari", "GUEST");
            Joined originalJoined = joinWithTicket(original, HOST_ID, "Leon", "HOST");
            guest.awaitEvent(type("participant.joined"), WAIT);

            original.send(signerRequest(HOST_REQUEST_ID, HOST_STREAM_ID, 0));
            original.awaitEvent(type("signer.granted"), WAIT);
            original.awaitEvent(type("participant.updated"), WAIT);
            guest.awaitEvent(type("signer.granted"), WAIT);
            guest.awaitEvent(type("participant.updated"), WAIT);

            replacement.send(objectMapper.writeValueAsString(
                    new ResumeJoinCommand(1, "room.join", originalJoined.resumeToken())));
            JsonNode replacementJoined = replacement.awaitEvent(type("room.joined"), WAIT);
            JsonNode replacementSnapshot = replacement.awaitEvent(type("room.snapshot"), WAIT);
            original.awaitClosed(WAIT);
            JsonNode released = guest.awaitEvent(type("signer.released"), WAIT);
            JsonNode inactive = guest.awaitEvent(type("participant.updated"), WAIT);

            assertThat(replacementJoined.path("participantId").asText()).isEqualTo(HOST_ID.toString());
            assertThat(replacementSnapshot.path("sequence").asLong())
                    .isEqualTo(replacementJoined.path("sequence").asLong());
            assertThat(released.path("payload").path("reason").asText()).isEqualTo("disconnected");
            assertThat(inactive.path("sequence").asLong())
                    .isEqualTo(released.path("sequence").asLong() + 1);

            assertThat(guest.pollEvent(Duration.ofMillis(200))).isNull();

            replacement.send(signerRequest(GUEST_REQUEST_ID, RECONNECTED_STREAM_ID, 0));
            JsonNode granted = replacement.awaitEvent(type("signer.granted"), WAIT);
            replacement.awaitEvent(type("participant.updated"), WAIT);
            guest.awaitEvent(type("signer.granted"), WAIT);
            guest.awaitEvent(type("participant.updated"), WAIT);
            assertThat(granted.path("payload").path("streamId").asText())
                    .isEqualTo(RECONNECTED_STREAM_ID.toString());

            original.close();
            assertThat(guest.pollEvent(Duration.ofMillis(300))).isNull();
        }
    }

    @Test
    void rejectsReplayOfARotatedResumeTokenWithoutDisplacingTheReplacement() throws Exception {
        try (WebSocketProbe guest = connect();
             WebSocketProbe original = connect();
             WebSocketProbe replacement = connect();
             WebSocketProbe replay = connect()) {
            joinWithTicket(guest, GUEST_ID, "Ari", "GUEST");
            Joined originalJoined = joinWithTicket(original, HOST_ID, "Leon", "HOST");
            guest.awaitEvent(type("participant.joined"), WAIT);

            replacement.send(objectMapper.writeValueAsString(
                    new ResumeJoinCommand(1, "room.join", originalJoined.resumeToken())));
            JsonNode replacementJoined = replacement.awaitEvent(type("room.joined"), WAIT);
            replacement.awaitEvent(type("room.snapshot"), WAIT);
            original.awaitClosed(WAIT);

            replay.send(objectMapper.writeValueAsString(
                    new ResumeJoinCommand(1, "room.join", originalJoined.resumeToken())));
            JsonNode replayError = replay.awaitEvent(type("room.error"), WAIT);

            assertThat(replayError.path("payload").path("code").asText()).isEqualTo("INVALID_JOIN");
            assertThat(replacementJoined.path("resumeToken").asText())
                    .isNotEqualTo(originalJoined.resumeToken());

            replacement.send(signerRequest(HOST_REQUEST_ID, RECONNECTED_STREAM_ID, 0));
            JsonNode granted = replacement.awaitEvent(type("signer.granted"), WAIT);
            assertThat(granted.path("payload").path("streamId").asText())
                    .isEqualTo(RECONNECTED_STREAM_ID.toString());
        }
    }

    private WebSocketProbe connect() {
        return connect(MEETING_ID);
    }

    private WebSocketProbe connect(UUID meetingId) {
        return WebSocketProbe.connect(
                URI.create("ws://localhost:%d/ws/v1/realtime/%s".formatted(port, meetingId)),
                objectMapper,
                WAIT);
    }

    private Joined joinWithTicket(
            WebSocketProbe socket,
            UUID participantId,
            String displayName,
            String role) throws Exception {
        String ticket = ticketCodec.issue(new RealtimeTicketCodec.Claims(
                MEETING_ID,
                participantId,
                displayName,
                role,
                Instant.now().plusSeconds(300)));
        socket.send(objectMapper.writeValueAsString(new TicketJoinCommand(1, "room.join", ticket)));
        JsonNode joined = socket.awaitEvent(type("room.joined"), WAIT);
        socket.awaitEvent(type("room.snapshot"), WAIT);
        socket.awaitEvent(type("participant.joined"), WAIT);
        return new Joined(
                joined.path("resumeToken").asText(),
                joined.path("resumeExpiresAt").asText());
    }

    private String signerRequest(UUID requestId, UUID streamId, long sequence) throws Exception {
        return objectMapper.writeValueAsString(
                new SignerRequest(1, "signer.request", requestId, streamId, sequence, sequence * 40.0));
    }

    private static String recognitionControl(UUID streamId, long sequence, String action) {
        return """
                {"schemaVersion":1,"type":"recognition.control","streamId":"%s",\
                "sequence":%d,"timestampMs":%s,"action":"%s"}
                """.formatted(streamId, sequence, sequence * 40.0, action);
    }

    private String landmarkChunkFor(UUID streamId) throws Exception {
        com.fasterxml.jackson.databind.node.ObjectNode chunk =
                (com.fasterxml.jackson.databind.node.ObjectNode) RealtimeTestFixtures.fixtureTree(
                        "landmark-chunk.valid.json", objectMapper);
        chunk.put("streamId", streamId.toString());
        return chunk.toString();
    }

    private static java.util.function.Predicate<JsonNode> type(String expected) {
        return event -> expected.equals(event.path("type").asText());
    }

    private record TicketJoinCommand(int schemaVersion, String type, String ticket) {
    }

    private record ResumeJoinCommand(int schemaVersion, String type, String resumeToken) {
    }

    private record SignerRequest(
            int schemaVersion,
            String type,
            UUID requestId,
            UUID streamId,
            long sequence,
            double timestampMs) {
    }

    private record Joined(String resumeToken, String resumeExpiresAt) {
    }
}
