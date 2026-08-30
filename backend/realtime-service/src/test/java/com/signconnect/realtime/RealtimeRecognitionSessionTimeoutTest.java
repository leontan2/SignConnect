package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.inference.InferenceClient;
import com.signconnect.realtime.inference.InferenceClient.InferenceUnavailableException;
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

class RealtimeRecognitionSessionTimeoutTest {

    private static final UUID MEETING_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID STREAM_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void trackingTimeoutStartsOnlyAfterFirstChunkAndReschedulesFromEveryAcceptedChunk() throws Exception {
        Harness harness = new Harness(Mono.never());
        List<String> chunks = RealtimeTestFixtures.generatedChunks(harness.objectMapper, 0, 2, true);

        harness.start();
        harness.scheduler.advanceTimeBy(Duration.ofMinutes(1));
        assertThat(harness.eventsOfType("recognition.status"))
                .extracting(event -> event.path("payload").path("reason").asText())
                .containsExactly("STARTED");

        harness.send(chunks.get(0));
        harness.scheduler.advanceTimeBy(Duration.ofMillis(1_999));
        harness.send(chunks.get(1));
        harness.scheduler.advanceTimeBy(Duration.ofMillis(2));
        assertThat(harness.statusesWithReason("OUT_OF_ORDER")).isEmpty();

        harness.scheduler.advanceTimeBy(Duration.ofMillis(1_998));
        assertThat(harness.statusesWithReason("OUT_OF_ORDER")).hasSize(1);
        harness.close();
    }

    @Test
    void scheduledTimeoutClearsStateAndSuppressesAStaleNonCancellableInferenceResponse() throws Exception {
        TestPublisher<InferenceClient.Prediction> delayed =
                TestPublisher.createNoncompliant(DEFER_CANCELLATION);
        AtomicInteger calls = new AtomicInteger();
        Harness harness = new Harness(null);
        when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
            RollingLandmarkWindow.Window window = invocation.getArgument(1);
            if (calls.getAndIncrement() == 0) {
                return delayed.mono();
            }
            return Mono.just(prediction(window, "NO_SIGN", null, 0.20));
        });
        List<String> active = RealtimeTestFixtures.generatedChunks(harness.objectMapper, 0, 6, true);
        List<String> idle = RealtimeTestFixtures.generatedChunks(harness.objectMapper, 6, 6, false);

        harness.start();
        active.forEach(harness::send);
        assertThat(calls).hasValue(1);

        harness.scheduler.advanceTimeBy(Duration.ofSeconds(2));
        delayed.next(predictionForSequence(0, "STALE_LABEL", "Must never be emitted", 0.99)).complete();
        idle.forEach(harness::send);

        assertThat(harness.statusesWithReason("OUT_OF_ORDER")).hasSize(1);
        assertThat(harness.eventsOfType("caption.final")).isEmpty();
        assertThat(calls).hasValue(2);
        harness.close();
    }

    @Test
    void consecutiveInferenceFailuresClearVotesAndWindowsBeforeFreshInputCanRecover() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        Harness harness = new Harness(null);
        when(harness.inferenceClient.predict(any(), any())).thenAnswer(invocation -> {
            RollingLandmarkWindow.Window window = invocation.getArgument(1);
            return switch (calls.getAndIncrement()) {
                case 0 -> Mono.just(prediction(window, "ARMED", "Must not survive outage", 0.99));
                case 1 -> Mono.error(new InferenceUnavailableException(InferenceClient.FailureReason.TIMEOUT));
                case 2 -> Mono.error(new InferenceUnavailableException(
                        InferenceClient.FailureReason.SERVICE_UNAVAILABLE));
                case 3 -> Mono.just(prediction(window, "NO_SIGN", null, 0.10));
                case 4 -> Mono.just(prediction(window, "FRESH", "Fresh caption", 0.99));
                default -> Mono.just(prediction(window, "NO_SIGN", null, 0.10));
            };
        });
        List<String> chunks = RealtimeTestFixtures.generatedChunks(harness.objectMapper, 0, 21, false);

        harness.start();
        for (int index = 0; index <= 6; index++) {
            harness.send(chunks.get(index));
        }
        assertThat(calls).hasValue(2);
        assertThat(harness.statusesWithReason("TIMEOUT")).hasSize(1);

        for (int index = 7; index <= 11; index++) {
            harness.send(chunks.get(index));
        }
        assertThat(calls)
                .as("an outage must discard the old 30-frame window")
                .hasValue(2);

        harness.send(chunks.get(12));
        assertThat(calls).hasValue(3);
        assertThat(harness.eventsOfType("recognition.status").stream()
                .filter(event -> "UNAVAILABLE".equals(event.path("payload").path("state").asText())))
                .as("timeout and service failure must share one unavailable episode")
                .hasSize(1);

        for (int index = 13; index <= 17; index++) {
            harness.send(chunks.get(index));
        }
        assertThat(calls)
                .as("the second outage must also discard its old window")
                .hasValue(3);

        harness.send(chunks.get(18));
        assertThat(harness.eventsOfType("caption.final"))
                .as("the armed pre-outage vote must not cross recovery")
                .isEmpty();
        assertThat(harness.statusesWithReason("RECOVERED")).hasSize(1);

        harness.send(chunks.get(19));
        harness.send(chunks.get(20));
        assertThat(harness.eventsOfType("caption.final"))
                .singleElement()
                .satisfies(event -> assertThat(event.path("payload").path("text").asText())
                        .isEqualTo("Fresh caption"));
        harness.close();
    }

    @Test
    void reportsAStopTransitionOnlyForAnAcceptedInOrderControl() throws Exception {
        Harness harness = new Harness(Mono.never());
        harness.start();

        JsonNode outOfOrder = harness.objectMapper.readTree(
                RealtimeTestFixtures.fixture("recognition-control-stop.valid.json"));
        ((com.fasterxml.jackson.databind.node.ObjectNode) outOfOrder).put("sequence", 2);

        assertThat(harness.accept(outOfOrder.toString())).isFalse();
        assertThat(harness.accept(RealtimeTestFixtures.fixture(
                "recognition-control-extra-video.invalid.json"))).isFalse();
        assertThat(harness.accept(RealtimeTestFixtures.fixture(
                "recognition-control-stop.valid.json"))).isTrue();
        harness.close();
    }

    private static InferenceClient.Prediction prediction(
            RollingLandmarkWindow.Window window,
            String labelId,
            String caption,
            double confidence) {
        return predictionForSequence(window.sequence(), labelId, caption, confidence);
    }

    private static InferenceClient.Prediction predictionForSequence(
            long windowSequence,
            String labelId,
            String caption,
            double confidence) {
        return new InferenceClient.Prediction(
                1,
                UUID.randomUUID(),
                STREAM_ID,
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

        private Harness(Mono<InferenceClient.Prediction> defaultPrediction) {
            RecognitionProperties properties = new RecognitionProperties();
            properties.setTrackingTimeout(Duration.ofSeconds(2));
            properties.setStableActiveEvaluations(1);
            properties.setIdleEvaluations(1);
            if (defaultPrediction != null) {
                when(inferenceClient.predict(any(), any())).thenReturn(defaultPrediction);
            }
            session = new RealtimeRecognitionSession(
                    MEETING_ID,
                    objectMapper,
                    properties,
                    inferenceClient,
                    Clock.fixed(NOW, ZoneOffset.UTC),
                    scheduler);
            session.outboundMessages().subscribe(outbound::add);
        }

        private void start() throws Exception {
            send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
        }

        private void send(String message) {
            accept(message);
        }

        private boolean accept(String message) {
            return session.acceptText(message, message.getBytes(StandardCharsets.UTF_8).length);
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
