package com.signconnect.realtime.room;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.CaptionPayload;
import com.signconnect.realtime.api.ChatMessageEvent;
import com.signconnect.realtime.api.CallSignalEvent;
import com.signconnect.realtime.config.RoomProperties;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InMemoryRoomRegistryTest {

    private static final Instant NOW = Instant.parse("2026-08-30T03:00:00Z");
    private static final UUID MEETING_ID = UUID.fromString("77777777-7777-4777-8777-777777777777");
    private static final UUID PARTICIPANT_ID = UUID.fromString("88888888-8888-4888-8888-888888888888");
    private static final UUID REQUEST_ID = UUID.fromString("99999999-9999-4999-8999-999999999999");
    private static final UUID STREAM_ID = UUID.fromString("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");

    private final ObjectMapper objectMapper = new ObjectMapper()
            .findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final InMemoryRoomRegistry registry = new InMemoryRoomRegistry(
            objectMapper,
            Clock.fixed(NOW, ZoneOffset.UTC),
            new RoomProperties());

    @Test
    void publishesOneStableOrderedCaptionForADuplicateFinalEvent() throws Exception {
        List<String> outbound = new ArrayList<>();
        RoomMembership membership = registry.join(
                participant(), outbound::add, () -> { }, "resume-token", NOW.plusSeconds(300));
        registry.requestSigner(membership, REQUEST_ID, STREAM_ID);
        CaptionEvent caption = new CaptionEvent(
                1,
                "caption.final",
                MEETING_ID,
                STREAM_ID,
                12,
                new CaptionPayload("HELLO", "Hello", 0.95, "mock-v1", 8.0, true),
                NOW);

        registry.publishCaption(membership, caption);
        registry.publishCaption(membership, caption);

        List<JsonNode> captions = outbound.stream()
                .map(this::read)
                .filter(event -> "caption.final".equals(event.path("type").asText()))
                .toList();
        assertThat(captions).hasSize(1);
        assertThat(captions.getFirst().path("captionId").asText())
                .isEqualTo("214afa68-2550-3b0d-8d8e-8f47a6f426e6");

        List<Long> publicSequences = outbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong())
                .toList();
        assertThat(publicSequences).containsExactly(0L, 1L, 2L, 3L, 4L);
    }

    @Test
    void publishesOneAttributedChatMessageForADuplicateClientMessageId() {
        List<String> hostOutbound = new ArrayList<>();
        List<String> guestOutbound = new ArrayList<>();
        RoomMembership host = registry.join(
                participant(), hostOutbound::add, () -> { }, "host-resume", NOW.plusSeconds(300));
        registry.join(
                new RoomParticipant(
                        MEETING_ID,
                        UUID.fromString("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
                        "Ari",
                        "GUEST"),
                guestOutbound::add,
                () -> { },
                "guest-resume",
                NOW.plusSeconds(300));
        ChatMessageEvent chat = new ChatMessageEvent(
                1,
                "chat.message",
                UUID.fromString("33333333-3333-4333-8333-333333333333"),
                "Can you repeat that sign?");

        registry.publishChat(host, chat);
        registry.publishChat(host, chat);

        List<JsonNode> hostMessages = hostOutbound.stream()
                .map(this::read)
                .filter(event -> "chat.message".equals(event.path("type").asText()))
                .toList();
        List<JsonNode> guestMessages = guestOutbound.stream()
                .map(this::read)
                .filter(event -> "chat.message".equals(event.path("type").asText()))
                .toList();
        assertThat(hostMessages).hasSize(1);
        assertThat(guestMessages).containsExactlyElementsOf(hostMessages);
        JsonNode published = hostMessages.getFirst();
        assertThat(published.path("participantId").asText()).isEqualTo(PARTICIPANT_ID.toString());
        assertThat(published.path("payload").path("sourceDisplayName").asText()).isEqualTo("Leon");
        assertThat(published.path("payload").path("text").asText()).isEqualTo("Can you repeat that sign?");
        assertThat(published.path("occurredAt").asText()).isEqualTo(NOW.toString());
    }

    @Test
    void routesACallOfferOnlyToTheNamedParticipantInTheSameRoom() throws Exception {
        List<String> hostOutbound = new ArrayList<>();
        List<String> guestOutbound = new ArrayList<>();
        RoomMembership host = registry.join(
                participant(), hostOutbound::add, () -> { }, "host-resume", NOW.plusSeconds(300));
        UUID guestId = UUID.fromString("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
        registry.join(
                new RoomParticipant(MEETING_ID, guestId, "Ari", "GUEST"),
                guestOutbound::add,
                () -> { },
                "guest-resume",
                NOW.plusSeconds(300));
        int hostBaseline = hostOutbound.size();
        int guestBaseline = guestOutbound.size();
        CallSignalEvent offer = objectMapper.readValue("""
                {
                  "schemaVersion": 1,
                  "type": "call.offer",
                  "signalId": "12121212-1212-4212-8212-121212121212",
                  "callId": "34343434-3434-4434-8434-343434343434",
                  "targetParticipantId": "%s",
                  "payload": {"sdp": "v=0\\r\\n"}
                }
                """.formatted(guestId), CallSignalEvent.class);

        assertThat(registry.routeCallSignal(host, offer)).isTrue();
        assertThat(registry.routeCallSignal(host, offer)).isTrue();

        assertThat(hostOutbound).hasSize(hostBaseline);
        assertThat(guestOutbound).hasSize(guestBaseline + 1);
        JsonNode routed = read(guestOutbound.getLast());
        assertThat(routed.path("type").asText()).isEqualTo("call.offer");
        assertThat(routed.path("participantId").asText()).isEqualTo(PARTICIPANT_ID.toString());
        assertThat(routed.path("targetParticipantId").asText()).isEqualTo(guestId.toString());
        assertThat(routed.path("payload").path("sdp").asText()).isEqualTo("v=0\r\n");
        assertThat(routed.path("sequence").asLong()).isEqualTo(2L);

        registry.publishChat(host, new ChatMessageEvent(
                1,
                "chat.message",
                UUID.fromString("56565656-5656-4565-8565-565656565656"),
                "The call is ready."));

        assertThat(hostOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(0L, 1L, 2L, 3L);
        assertThat(guestOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(1L, 2L, 3L);
    }

    @Test
    void rejectsFractionalIceCandidateLineIndexesAtTheRoomBoundary() throws Exception {
        List<String> hostOutbound = new ArrayList<>();
        List<String> guestOutbound = new ArrayList<>();
        RoomMembership host = registry.join(
                participant(), hostOutbound::add, () -> { }, "host-resume", NOW.plusSeconds(300));
        UUID guestId = UUID.fromString("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb");
        registry.join(
                new RoomParticipant(MEETING_ID, guestId, "Ari", "GUEST"),
                guestOutbound::add,
                () -> { },
                "guest-resume",
                NOW.plusSeconds(300));
        int guestBaseline = guestOutbound.size();
        CallSignalEvent candidate = objectMapper.readValue("""
                {
                  "schemaVersion": 1,
                  "type": "call.ice-candidate",
                  "signalId": "78787878-7878-4787-8787-787878787878",
                  "callId": "34343434-3434-4434-8434-343434343434",
                  "targetParticipantId": "%s",
                  "payload": {"candidate": "candidate:1", "sdpMLineIndex": 0.5}
                }
                """.formatted(guestId), CallSignalEvent.class);

        assertThat(registry.routeCallSignal(host, candidate)).isFalse();
        assertThat(guestOutbound).hasSize(guestBaseline);
    }

    @Test
    void refusesASecondLiveConnectionForTheSameParticipantIdentity() {
        registry.join(participant(), ignored -> { }, () -> { }, "resume-one", NOW.plusSeconds(300));

        assertThatThrownBy(() -> registry.join(
                participant(), ignored -> { }, () -> { }, "resume-two", NOW.plusSeconds(300)))
                .isInstanceOf(RoomRegistry.ParticipantAlreadyConnectedException.class);
    }

    @Test
    void grantsOneSignerThenReleasesOwnershipForTheWaitingParticipant() {
        List<String> hostOutbound = new ArrayList<>();
        List<String> guestOutbound = new ArrayList<>();
        RoomMembership host = registry.join(
                participant(), hostOutbound::add, () -> { }, "host-resume", NOW.plusSeconds(300));
        RoomMembership guest = registry.join(
                new RoomParticipant(
                        MEETING_ID,
                        UUID.fromString("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
                        "Ari",
                        "GUEST"),
                guestOutbound::add,
                () -> { },
                "guest-resume",
                NOW.plusSeconds(300));

        registry.requestSigner(host, REQUEST_ID, STREAM_ID);
        int hostAfterGrant = hostOutbound.size();
        registry.requestSigner(
                guest,
                UUID.fromString("cccccccc-3333-4333-8333-cccccccccccc"),
                UUID.fromString("dddddddd-4444-4444-8444-dddddddddddd"));

        assertThat(registry.ownsSigner(host, STREAM_ID)).isTrue();
        assertThat(hostOutbound).hasSize(hostAfterGrant);
        JsonNode denied = read(guestOutbound.getLast());
        assertThat(denied.path("type").asText()).isEqualTo("signer.denied");
        assertThat(denied.path("payload").path("reason").asText())
                .isEqualTo("SIGNER_UNAVAILABLE");

        assertThat(registry.releaseSigner(host, STREAM_ID, "user_request")).isTrue();
        assertThat(registry.ownsSigner(host, STREAM_ID)).isFalse();
        assertThat(read(guestOutbound.get(guestOutbound.size() - 2)).path("type").asText())
                .isEqualTo("signer.released");
        assertThat(read(guestOutbound.getLast()).path("type").asText())
                .isEqualTo("participant.updated");

        assertThat(hostOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(0L, 1L, 2L, 3L, 4L, 5L, 6L);
    }

    @Test
    void removesAnEmptyRoomSoSequenceAndDedupeStateCannotGrowForever() {
        RoomMembership first = registry.join(
                participant(), ignored -> { }, () -> { }, "first-resume", NOW.plusSeconds(300));
        registry.leave(first);

        List<String> replacementOutbound = new ArrayList<>();
        registry.join(
                participant(), replacementOutbound::add, () -> { }, "second-resume", NOW.plusSeconds(300));

        assertThat(replacementOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(0L, 1L);
    }

    @Test
    void rejectsResumeWhenTheTargetRoomDoesNotExist() {
        assertThatThrownBy(() -> registry.resume(
                participant(),
                ignored -> { },
                () -> { },
                "resume-token",
                "rotated-resume-token",
                NOW.plusSeconds(300)))
                .isInstanceOf(RoomRegistry.RoomNotFoundException.class);
    }

    @Test
    void atomicallyReplacesAnExistingParticipantWhenResuming() {
        List<String> originalOutbound = new ArrayList<>();
        List<String> guestOutbound = new ArrayList<>();
        List<String> replacementOutbound = new ArrayList<>();
        AtomicBoolean originalInvalidated = new AtomicBoolean();
        RoomMembership original = registry.join(
                participant(),
                originalOutbound::add,
                () -> originalInvalidated.set(true),
                "first-resume",
                NOW.plusSeconds(300));
        registry.join(
                new RoomParticipant(
                        MEETING_ID,
                        UUID.fromString("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
                        "Ari",
                        "GUEST"),
                guestOutbound::add,
                () -> { },
                "guest-resume",
                NOW.plusSeconds(300));
        registry.requestSigner(original, REQUEST_ID, STREAM_ID);
        int originalEventCount = originalOutbound.size();

        RoomMembership replacement = registry.resume(
                participant(),
                replacementOutbound::add,
                () -> { },
                "first-resume",
                "second-resume",
                NOW.plusSeconds(300));
        registry.leave(original);

        UUID replacementRequestId = UUID.fromString("cccccccc-3333-4333-8333-cccccccccccc");
        UUID replacementStreamId = UUID.fromString("dddddddd-4444-4444-8444-dddddddddddd");
        registry.requestSigner(original, UUID.randomUUID(), UUID.randomUUID());
        registry.requestSigner(replacement, replacementRequestId, replacementStreamId);

        assertThat(originalOutbound).hasSize(originalEventCount);
        assertThat(originalInvalidated).isTrue();
        assertThat(registry.ownsSigner(original, STREAM_ID)).isFalse();
        assertThat(registry.ownsSigner(replacement, replacementStreamId)).isTrue();
        assertThat(replacementOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(6L, 7L, 8L);
        assertThat(guestOutbound.stream()
                .map(this::read)
                .filter(this::isPublicOrderedEvent)
                .map(event -> event.path("sequence").asLong()))
                .containsExactly(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L);
    }

    @Test
    void consumesEachResumeTokenExactlyOnce() {
        registry.join(
                participant(), ignored -> { }, () -> { }, "first-resume", NOW.plusSeconds(300));

        registry.resume(
                participant(),
                ignored -> { },
                () -> { },
                "first-resume",
                "second-resume",
                NOW.plusSeconds(300));

        assertThatThrownBy(() -> registry.resume(
                participant(),
                ignored -> { },
                () -> { },
                "first-resume",
                "third-resume",
                NOW.plusSeconds(300)))
                .isInstanceOf(RoomRegistry.InvalidResumeTokenException.class);
    }

    private RoomParticipant participant() {
        return new RoomParticipant(MEETING_ID, PARTICIPANT_ID, "Leon", "HOST");
    }

    private JsonNode read(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (Exception exception) {
            throw new AssertionError("Registry emitted invalid JSON", exception);
        }
    }

    private boolean isPublicOrderedEvent(JsonNode event) {
        return switch (event.path("type").asText()) {
            case "room.snapshot", "participant.joined", "participant.updated", "participant.left",
                    "signer.granted", "signer.released", "caption.final", "chat.message" -> true;
            default -> false;
        };
    }
}
