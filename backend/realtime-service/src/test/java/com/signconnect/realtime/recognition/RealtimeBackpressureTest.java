package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "signconnect.recognition.inference-timeout=500ms",
                "signconnect.recognition.stable-active-evaluations=1",
                "signconnect.recognition.idle-evaluations=1",
                "signconnect.recognition.max-message-size=32KB",
                "signconnect.recognition.tracking-timeout=5s"
        })
class RealtimeBackpressureTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final String MEETING_ID = "22222222-2222-4222-8222-222222222222";
    private static final String FIRST_STREAM = "11111111-1111-4111-8111-111111111111";
    private static final String SECOND_STREAM = "33333333-3333-4333-8333-333333333333";
    private static final TestInferenceBoundary INFERENCE = TestInferenceBoundary.start();

    @DynamicPropertySource
    static void inferenceProperties(DynamicPropertyRegistry registry) {
        registry.add("signconnect.recognition.inference-url", INFERENCE::baseUrl);
    }

    @Value("${local.server.port}")
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @BeforeEach
    void resetBoundary() {
        INFERENCE.reset();
    }

    @AfterAll
    static void stopBoundary() {
        INFERENCE.close();
    }

    @Test
    void keepsOneCallInFlightAndReplacesPendingWorkWithNewestCompleteWindow() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.delayedActive(Duration.ofMillis(250)),
                TestInferenceBoundary.ResponsePlan.active());
        List<String> chunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 13, true);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();

            for (int index = 0; index <= 5; index++) {
                socket.send(chunks.get(index));
            }
            TestInferenceBoundary.RequestSummary first = INFERENCE.awaitRequest(WAIT);

            for (int index = 6; index < chunks.size(); index++) {
                socket.send(chunks.get(index));
            }
            INFERENCE.awaitCompletedAtLeast(2, WAIT);

            assertThat(INFERENCE.maximumInFlight()).isEqualTo(1);
            assertThat(INFERENCE.requestCount()).isEqualTo(2);
            assertThat(first.windowSequence()).isZero();
            assertThat(INFERENCE.requestSummaries().get(1).windowSequence()).isEqualTo(7);
            assertThat(INFERENCE.requestSummaries().get(1).firstFrameSequence()).isEqualTo(35);
            assertThat(INFERENCE.requestSummaries().get(1).lastFrameSequence()).isEqualTo(64);
        }
    }

    @Test
    void dropsDelayedResponseFromReplacedStreamGeneration() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.delayedLabel(
                        "STALE_LABEL", "Must never be emitted", Duration.ofMillis(400)),
                TestInferenceBoundary.ResponsePlan.idle());
        List<String> firstChunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 6, true);
        List<String> secondChunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 6, false)
                .stream()
                .map(chunk -> chunk.replace(FIRST_STREAM, SECOND_STREAM))
                .toList();
        ObjectNode secondStart = (ObjectNode) RealtimeTestFixtures.fixtureTree(
                "recognition-control-start.valid.json", objectMapper);
        secondStart.put("streamId", SECOND_STREAM);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            firstChunks.forEach(socket::send);
            assertThat(INFERENCE.awaitRequest(WAIT).streamId()).isEqualTo(FIRST_STREAM);

            socket.send(secondStart.toString());
            JsonNode restarted = socket.awaitEvent(reason("STARTED"), WAIT);
            assertThat(restarted.path("streamId").asText()).isEqualTo(SECOND_STREAM);
            secondChunks.forEach(socket::send);

            TestInferenceBoundary.RequestSummary replacement =
                    INFERENCE.pollRequest(Duration.ofMillis(200));
            assertThat(replacement)
                    .as("a replacement stream must not wait for stale inference")
                    .isNotNull();
            assertThat(replacement.streamId()).isEqualTo(SECOND_STREAM);
            INFERENCE.awaitCompletedAtLeast(2, WAIT);

            assertThat(INFERENCE.requestSummaries()).extracting(TestInferenceBoundary.RequestSummary::streamId)
                    .containsExactly(FIRST_STREAM, SECOND_STREAM);
            assertThat(socket.pollEvent(Duration.ofMillis(200))).isNull();
        }
    }

    @Test
    void stopDisposesStaleInferenceSoRestartCanInferImmediately() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.delayedLabel(
                        "STALE_LABEL", "Must never be emitted", Duration.ofMillis(400)),
                TestInferenceBoundary.ResponsePlan.idle());
        List<String> firstChunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 6, true);
        List<String> secondChunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 6, false)
                .stream()
                .map(chunk -> chunk.replace(FIRST_STREAM, SECOND_STREAM))
                .toList();
        ObjectNode secondStart = (ObjectNode) RealtimeTestFixtures.fixtureTree(
                "recognition-control-start.valid.json", objectMapper);
        secondStart.put("streamId", SECOND_STREAM);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            firstChunks.forEach(socket::send);
            assertThat(INFERENCE.awaitRequest(WAIT).streamId()).isEqualTo(FIRST_STREAM);

            socket.send(RealtimeTestFixtures.fixture("recognition-control-stop.valid.json"));
            assertThat(socket.awaitEvent(reason("STOPPED_BY_CLIENT"), WAIT)).isNotNull();
            socket.send(secondStart.toString());
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT).path("streamId").asText())
                    .isEqualTo(SECOND_STREAM);
            secondChunks.forEach(socket::send);

            TestInferenceBoundary.RequestSummary replacement =
                    INFERENCE.pollRequest(Duration.ofMillis(200));
            assertThat(replacement)
                    .as("a stopped stream must release its inference slot")
                    .isNotNull();
            assertThat(replacement.streamId()).isEqualTo(SECOND_STREAM);
            assertThat(socket.pollEvent(Duration.ofMillis(500))).isNull();
        }
    }

    @Test
    void orderResetDisposesStaleInferenceSoContinuousInputCanResumeImmediately() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.delayedLabel(
                        "STALE_LABEL", "Must never be emitted", Duration.ofMillis(400)),
                TestInferenceBoundary.ResponsePlan.idle());
        List<String> chunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 14, true);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            for (int index = 0; index <= 5; index++) {
                socket.send(chunks.get(index));
            }
            assertThat(INFERENCE.awaitRequest(WAIT).windowSequence()).isZero();

            socket.send(chunks.get(7));
            assertThat(socket.awaitEvent(reason("OUT_OF_ORDER"), WAIT)).isNotNull();
            for (int index = 8; index <= 13; index++) {
                socket.send(chunks.get(index));
            }

            TestInferenceBoundary.RequestSummary resumed =
                    INFERENCE.pollRequest(Duration.ofMillis(200));
            assertThat(resumed)
                    .as("an order reset must release its stale inference slot")
                    .isNotNull();
            assertThat(resumed.windowSequence()).isZero();
            assertThat(resumed.firstFrameSequence()).isEqualTo(40);
            assertThat(resumed.lastFrameSequence()).isEqualTo(69);
            assertThat(socket.pollEvent(Duration.ofMillis(500))).isNull();
        }
    }

    @Test
    void sequenceDiscontinuityResetsWindowBeforeInferenceResumes() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.active(),
                TestInferenceBoundary.ResponsePlan.active());
        List<String> chunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 14, true);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            for (int index = 0; index <= 5; index++) {
                socket.send(chunks.get(index));
            }
            INFERENCE.awaitCompletedAtLeast(1, WAIT);

            socket.send(chunks.get(7));
            assertThat(socket.awaitEvent(reason("OUT_OF_ORDER"), WAIT)).isNotNull();
            for (int index = 8; index <= 13; index++) {
                socket.send(chunks.get(index));
            }
            INFERENCE.awaitCompletedAtLeast(2, WAIT);

            TestInferenceBoundary.RequestSummary resumed = INFERENCE.requestSummaries().get(1);
            assertThat(resumed.windowSequence()).isZero();
            assertThat(resumed.firstFrameSequence()).isEqualTo(40);
            assertThat(resumed.lastFrameSequence()).isEqualTo(69);
        }
    }

    private WebSocketProbe connect() {
        return WebSocketProbe.connect(
                URI.create("ws://localhost:%d/ws/v1/realtime/%s".formatted(port, MEETING_ID)),
                objectMapper,
                WAIT);
    }

    private static java.util.function.Predicate<JsonNode> reason(String reason) {
        return event -> event.path("payload").path("reason").asText().equals(reason);
    }
}
