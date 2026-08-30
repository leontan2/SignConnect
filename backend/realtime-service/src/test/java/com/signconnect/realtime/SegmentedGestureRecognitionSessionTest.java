package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.inference.InferenceClient;
import com.signconnect.realtime.recognition.RealtimeRecognitionSession;
import com.signconnect.realtime.recognition.RollingLandmarkWindow;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.publisher.TestPublisher;
import reactor.test.scheduler.VirtualTimeScheduler;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static reactor.test.publisher.TestPublisher.Violation.DEFER_CANCELLATION;

class SegmentedGestureRecognitionSessionTest {

    private static final UUID MEETING_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID FIRST_STREAM = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID SECOND_STREAM = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void completedGesturesUseNonOverlappingWindowsAndEachRepeatedSignFinalizesOnce() throws Exception {
        try (Harness harness = new Harness()) {
            List<RollingLandmarkWindow.Window> requests = new ArrayList<>();
            when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
                UUID streamId = invocation.getArgument(0);
                RollingLandmarkWindow.Window window = invocation.getArgument(1);
                requests.add(window);
                return Mono.just(prediction(streamId, window, "MOCK_ACTIVE", "Repeated sign", 0.95));
            });

            harness.start(FIRST_STREAM);
            harness.sendChunks(0, 12, true, FIRST_STREAM);

            assertThat(requests).hasSize(2);
            assertThat(requests).extracting(RollingLandmarkWindow.Window::sequence)
                    .containsExactly(0L, 1L);
            assertThat(requests.get(0).frames()).extracting(frame -> frame.sequence())
                    .containsExactlyElementsOf(longRange(0, 29));
            assertThat(requests.get(1).frames()).extracting(frame -> frame.sequence())
                    .containsExactlyElementsOf(longRange(30, 59));
            assertThat(harness.eventsOfType("caption.final"))
                    .hasSize(2)
                    .allSatisfy(event -> assertThat(event.path("payload").path("text").asText())
                            .isEqualTo("Repeated sign"));
            assertThat(harness.eventsOfType("recognition.unknown")).isEmpty();
        }
    }

    @Test
    void noSignAndLowConfidenceCompletedGesturesReturnPrivateUnknownWithoutCaptions() throws Exception {
        try (Harness harness = new Harness()) {
            AtomicInteger calls = new AtomicInteger();
            when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
                UUID streamId = invocation.getArgument(0);
                RollingLandmarkWindow.Window window = invocation.getArgument(1);
                return calls.getAndIncrement() == 0
                        ? Mono.just(prediction(streamId, window, "NO_SIGN", null, 0.99))
                        : Mono.just(prediction(streamId, window, "MOCK_ACTIVE", "Rejected", 0.79));
            });

            harness.start(FIRST_STREAM);
            harness.sendChunks(0, 12, true, FIRST_STREAM);

            assertThat(calls).hasValue(2);
            assertThat(harness.eventsOfType("recognition.unknown"))
                    .hasSize(2)
                    .allSatisfy(event -> assertThat(event.path("payload").path("reason").asText())
                            .isEqualTo("LOW_CONFIDENCE"));
            assertThat(harness.eventsOfType("caption.final")).isEmpty();
        }
    }

    @Test
    void oneInFlightInferenceKeepsOnlyTheLatestCompletedGestureCandidate() throws Exception {
        try (Harness harness = new Harness()) {
            TestPublisher<InferenceClient.Prediction> delayed = TestPublisher.create();
            List<RollingLandmarkWindow.Window> requests = new ArrayList<>();
            when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
                UUID streamId = invocation.getArgument(0);
                RollingLandmarkWindow.Window window = invocation.getArgument(1);
                requests.add(window);
                if (requests.size() == 1) {
                    return delayed.mono();
                }
                return Mono.just(prediction(streamId, window, "MOCK_ACTIVE", "Newest sign", 0.95));
            });

            harness.start(FIRST_STREAM);
            harness.sendChunks(0, 18, true, FIRST_STREAM);
            assertThat(requests).singleElement()
                    .extracting(RollingLandmarkWindow.Window::sequence)
                    .isEqualTo(0L);

            delayed.emit(prediction(FIRST_STREAM, requests.getFirst(), "NO_SIGN", null, 0.99));

            assertThat(requests).extracting(RollingLandmarkWindow.Window::sequence)
                    .containsExactly(0L, 2L);
            assertThat(requests.get(1).frames()).extracting(frame -> frame.sequence())
                    .containsExactlyElementsOf(longRange(60, 89));
            assertThat(harness.eventsOfType("caption.final")).singleElement()
                    .satisfies(event -> assertThat(event.path("payload").path("text").asText())
                            .isEqualTo("Newest sign"));
        }
    }

    @Test
    void reconnectStreamDropsStaleInferenceAndStartsWithAFreshCandidate() throws Exception {
        try (Harness harness = new Harness()) {
            TestPublisher<InferenceClient.Prediction> stale =
                    TestPublisher.createNoncompliant(DEFER_CANCELLATION);
            AtomicInteger calls = new AtomicInteger();
            when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
                UUID streamId = invocation.getArgument(0);
                RollingLandmarkWindow.Window window = invocation.getArgument(1);
                if (calls.getAndIncrement() == 0) {
                    return stale.mono();
                }
                return Mono.just(prediction(streamId, window, "MOCK_ACTIVE", "Fresh sign", 0.95));
            });

            harness.start(FIRST_STREAM);
            harness.sendChunks(0, 6, true, FIRST_STREAM);
            harness.start(SECOND_STREAM);
            stale.next(prediction(FIRST_STREAM, 0, "STALE_LABEL", "Must not emit", 0.99)).complete();
            harness.sendChunks(0, 6, true, SECOND_STREAM);

            assertThat(calls).hasValue(2);
            assertThat(harness.eventsOfType("caption.final")).singleElement().satisfies(event -> {
                assertThat(event.path("streamId").asText()).isEqualTo(SECOND_STREAM.toString());
                assertThat(event.path("payload").path("text").asText()).isEqualTo("Fresh sign");
            });
        }
    }

    @Test
    void trackingTimeoutClearsAPartialGestureBeforeTheNextCandidate() throws Exception {
        try (Harness harness = new Harness()) {
            List<RollingLandmarkWindow.Window> requests = new ArrayList<>();
            when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
                UUID streamId = invocation.getArgument(0);
                RollingLandmarkWindow.Window window = invocation.getArgument(1);
                requests.add(window);
                return Mono.just(prediction(streamId, window, "MOCK_ACTIVE", "After timeout", 0.95));
            });

            harness.start(FIRST_STREAM);
            harness.sendChunks(0, 3, true, FIRST_STREAM);
            harness.scheduler.advanceTimeBy(Duration.ofSeconds(2));
            harness.sendChunks(3, 6, true, FIRST_STREAM);

            assertThat(harness.statusesWithReason("OUT_OF_ORDER")).hasSize(1);
            assertThat(requests).singleElement().satisfies(window -> {
                assertThat(window.sequence()).isZero();
                assertThat(window.frames()).extracting(frame -> frame.sequence())
                        .containsExactlyElementsOf(longRange(15, 44));
            });
            assertThat(harness.eventsOfType("caption.final")).hasSize(1);
        }
    }

    private static List<Long> longRange(long first, long last) {
        List<Long> values = new ArrayList<>();
        for (long value = first; value <= last; value++) {
            values.add(value);
        }
        return values;
    }

    private static InferenceClient.Prediction prediction(
            UUID streamId,
            RollingLandmarkWindow.Window window,
            String labelId,
            String caption,
            double confidence) {
        return prediction(streamId, window.sequence(), labelId, caption, confidence);
    }

    private static InferenceClient.Prediction prediction(
            UUID streamId,
            long windowSequence,
            String labelId,
            String caption,
            double confidence) {
        return new InferenceClient.Prediction(
                1,
                UUID.randomUUID(),
                streamId,
                windowSequence,
                labelId,
                caption,
                confidence,
                "synthetic-v1",
                1.0,
                true);
    }

    private static final class Harness implements AutoCloseable {

        private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
        private final VirtualTimeScheduler scheduler = VirtualTimeScheduler.create();
        private final InferenceClient inferenceClient = mock(InferenceClient.class);
        private final List<String> outbound = new ArrayList<>();
        private final RealtimeRecognitionSession session;

        private Harness() {
            RecognitionProperties properties = new RecognitionProperties();
            properties.setTrackingTimeout(Duration.ofSeconds(2));
            session = new RealtimeRecognitionSession(
                    MEETING_ID,
                    objectMapper,
                    properties,
                    inferenceClient,
                    Clock.fixed(NOW, ZoneOffset.UTC),
                    scheduler);
            session.outboundMessages().subscribe(outbound::add);
        }

        private void start(UUID streamId) throws Exception {
            ObjectNode start = (ObjectNode) RealtimeTestFixtures.fixtureTree(
                    "recognition-control-start.valid.json",
                    objectMapper);
            start.put("streamId", streamId.toString());
            send(start.toString());
        }

        private void sendChunks(int firstChunk, int count, boolean active, UUID streamId) throws Exception {
            for (String chunk : RealtimeTestFixtures.generatedChunks(
                    objectMapper,
                    firstChunk,
                    count,
                    active)) {
                send(chunk.replace(FIRST_STREAM.toString(), streamId.toString()));
            }
        }

        private void send(String message) {
            session.acceptText(message, message.getBytes(StandardCharsets.UTF_8).length);
        }

        private List<JsonNode> eventsOfType(String type) {
            return outbound.stream()
                    .map(this::readTree)
                    .filter(event -> type.equals(event.path("type").asText()))
                    .toList();
        }

        private List<JsonNode> statusesWithReason(String reason) {
            return eventsOfType("recognition.status").stream()
                    .filter(event -> reason.equals(event.path("payload").path("reason").asText()))
                    .toList();
        }

        private JsonNode readTree(String json) {
            try {
                return objectMapper.readTree(json);
            } catch (Exception exception) {
                throw new IllegalStateException("Session emitted invalid JSON", exception);
            }
        }

        @Override
        public void close() {
            session.close();
            scheduler.dispose();
        }
    }
}
