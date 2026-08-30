package com.signconnect.realtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.WebSocketSession;
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "signconnect.recognition.input-mode=ROLLING",
                "signconnect.recognition.inference-timeout=100ms",
                "signconnect.recognition.max-message-size=32KB",
                "signconnect.recognition.tracking-timeout=5s",
                "signconnect.rooms.require-join=false",
                "logging.level.com.signconnect.realtime=TRACE"
        })
@ExtendWith(OutputCaptureExtension.class)
class RealtimeRecognitionWebSocketTest {

    private static final Duration WAIT = Duration.ofSeconds(5);
    private static final String MEETING_ID = "22222222-2222-4222-8222-222222222222";
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

    static Stream<Arguments> invalidClientFixtures() {
        return Stream.of(
                Arguments.of("landmark-chunk-wrong-version.invalid.json", "UNSUPPORTED_VERSION"),
                Arguments.of("landmark-chunk-wrong-feature-count.invalid.json", "INVALID_EVENT"),
                Arguments.of("landmark-chunk-non-number.invalid.json", "INVALID_EVENT"),
                Arguments.of("landmark-chunk-missing-stream-id.invalid.json", "INVALID_EVENT"),
                Arguments.of("landmark-chunk-extra-raw-frame.invalid.json", "INVALID_EVENT"),
                Arguments.of("recognition-control-extra-video.invalid.json", "INVALID_EVENT")
        );
    }

    @ParameterizedTest(name = "rejects {0} without closing the connection")
    @MethodSource("invalidClientFixtures")
    void strictlyRejectsSharedInvalidFixturesAndKeepsConnectionUsable(
            String fixtureName,
            String expectedReason) throws Exception {
        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture(fixtureName));
            JsonNode invalid = socket.awaitEvent(event -> event.path("type").asText().equals("recognition.status"), WAIT);

            assertThat(invalid.path("payload").path("state").asText()).isEqualTo("INVALID_INPUT");
            assertThat(invalid.path("payload").path("reason").asText()).isEqualTo(expectedReason);
            assertSafeStatus(invalid);

            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            JsonNode ready = socket.awaitEvent(
                    event -> event.path("payload").path("reason").asText().equals("STARTED"), WAIT);
            assertThat(ready.path("payload").path("state").asText()).isEqualTo("READY");
        }
    }

    @Test
    void buildsFirstThirtyFrameWindowFromSharedReplayAtFiveFrameStride() throws Exception {
        INFERENCE.enqueue(TestInferenceBoundary.ResponsePlan.active());
        JsonNode replay = RealtimeTestFixtures.fixtureTree("active-to-idle.sequence.json", objectMapper);

        try (WebSocketProbe socket = connect()) {
            socket.send(replay.path("startControl").toString());
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();

            for (int index = 0; index < 5; index++) {
                socket.send(replay.path("chunks").get(index).toString());
            }
            assertThat(INFERENCE.pollRequest(Duration.ofMillis(150))).isNull();

            socket.send(replay.path("chunks").get(5).toString());
            TestInferenceBoundary.RequestSummary request = INFERENCE.awaitRequest(WAIT);
            INFERENCE.awaitCompletedAtLeast(1, WAIT);

            assertThat(request.validContract()).isTrue();
            assertThat(request.windowSequence()).isZero();
            assertThat(request.frameCount()).isEqualTo(30);
            assertThat(request.firstFrameSequence()).isZero();
            assertThat(request.lastFrameSequence()).isEqualTo(29);
        }
    }

    @Test
    void rejectsOversizeNonFiniteAndDiscontinuousInputWithSafeStatuses() throws Exception {
        ObjectNode oversized = (ObjectNode) RealtimeTestFixtures.fixtureTree(
                "landmark-chunk.valid.json", objectMapper);
        oversized.put("padding", "x".repeat(33_000));
        String overflow = RealtimeTestFixtures.fixture("landmark-chunk.valid.json")
                .replaceFirst("-0\\.45", "1e400");
        ObjectNode gap = (ObjectNode) RealtimeTestFixtures.fixtureTree(
                "landmark-chunk.valid.json", objectMapper);
        gap.put("sequence", 2);
        shiftFrames(gap, 10, 400.0);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();

            socket.send(oversized.toString());
            assertThat(socket.awaitEvent(reason("INVALID_EVENT"), WAIT)).isNotNull();

            socket.send(overflow);
            assertThat(socket.awaitEvent(reason("INVALID_EVENT"), WAIT)).isNotNull();

            socket.send(RealtimeTestFixtures.fixture("landmark-chunk.valid.json"));
            socket.send(gap.toString());
            JsonNode discontinuity = socket.awaitEvent(reason("OUT_OF_ORDER"), WAIT);
            assertThat(discontinuity.path("payload").path("state").asText()).isEqualTo("INVALID_INPUT");
            assertSafeStatus(discontinuity);
        }
    }

    @Test
    void emitsOneMetadataCompleteCaptionForSharedStableActiveThenIdleReplay() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.active(),
                TestInferenceBoundary.ResponsePlan.active(),
                TestInferenceBoundary.ResponsePlan.active(),
                TestInferenceBoundary.ResponsePlan.idle(),
                TestInferenceBoundary.ResponsePlan.idle());
        JsonNode replay = RealtimeTestFixtures.fixtureTree("active-to-idle.sequence.json", objectMapper);

        try (WebSocketProbe socket = connect()) {
            socket.send(replay.path("startControl").toString());
            JsonNode started = socket.awaitEvent(reason("STARTED"), WAIT);

            for (int index = 0; index < replay.path("chunks").size(); index++) {
                socket.send(replay.path("chunks").get(index).toString());
                if (index >= 5) {
                    INFERENCE.awaitCompletedAtLeast(index - 4, WAIT);
                }
            }

            JsonNode caption = socket.awaitEvent(
                    event -> event.path("type").asText().equals("caption.final"), WAIT);

            assertThat(started.path("sequence").asLong()).isZero();
            assertThat(caption.path("schemaVersion").asInt()).isEqualTo(1);
            assertThat(caption.path("meetingId").asText()).isEqualTo(MEETING_ID);
            assertThat(caption.path("streamId").asText())
                    .isEqualTo("11111111-1111-4111-8111-111111111111");
            assertThat(caption.path("sequence").asLong()).isEqualTo(1);
            assertThat(caption.path("payload").path("labelId").asText()).isEqualTo("MOCK_ACTIVE");
            assertThat(caption.path("payload").path("text").asText())
                    .isEqualTo("Synthetic active gesture");
            assertThat(caption.path("payload").path("confidence").asDouble()).isEqualTo(0.95);
            assertThat(caption.path("payload").path("modelVersion").asText()).isEqualTo("synthetic-v1");
            assertThat(caption.path("payload").path("inferenceLatencyMs").asDouble()).isEqualTo(3.5);
            assertThat(caption.path("payload").path("mockModel").asBoolean()).isTrue();
            assertThat(caption.path("occurredAt").asText()).isNotBlank();
            assertThat(socket.pollEvent(Duration.ofMillis(150))).isNull();
            assertThat(INFERENCE.requestSummaries()).extracting(TestInferenceBoundary.RequestSummary::windowSequence)
                    .containsExactly(0L, 1L, 2L, 3L, 4L);
        }
    }

    @Test
    void emitsUnknownWhenTrackedHandsRepeatedlyProduceNoSign() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.idle(),
                TestInferenceBoundary.ResponsePlan.idle(),
                TestInferenceBoundary.ResponsePlan.idle());
        List<String> activeChunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 8, true);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();

            for (int index = 0; index < activeChunks.size(); index++) {
                socket.send(activeChunks.get(index));
                if (index >= 5) {
                    INFERENCE.awaitCompletedAtLeast(index - 4, WAIT);
                }
            }

            JsonNode unknown = socket.awaitEvent(
                    event -> event.path("type").asText().equals("recognition.unknown"), WAIT);
            assertThat(unknown.path("payload").path("reason").asText()).isEqualTo("LOW_CONFIDENCE");
            assertThat(unknown.path("payload").path("confidence").asDouble()).isEqualTo(0.99);
            assertThat(socket.pollEvent(Duration.ofMillis(150))).isNull();
        }
    }

    @Test
    void emitsOneUnavailableStatusForTimeoutThenOneRecovery() throws Exception {
        INFERENCE.enqueue(
                TestInferenceBoundary.ResponsePlan.delayedActive(Duration.ofMillis(350)),
                TestInferenceBoundary.ResponsePlan.active());
        List<String> chunks = RealtimeTestFixtures.generatedChunks(objectMapper, 0, 12, true);

        try (WebSocketProbe socket = connect()) {
            socket.send(RealtimeTestFixtures.fixture("recognition-control-start.valid.json"));
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();

            for (int index = 0; index <= 5; index++) {
                socket.send(chunks.get(index));
            }

            JsonNode unavailable = socket.awaitEvent(
                    event -> event.path("payload").path("state").asText().equals("UNAVAILABLE"), WAIT);
            for (int index = 6; index < chunks.size(); index++) {
                socket.send(chunks.get(index));
            }
            JsonNode recovered = socket.awaitEvent(reason("RECOVERED"), WAIT);

            assertThat(unavailable.path("payload").path("reason").asText()).isEqualTo("TIMEOUT");
            assertThat(recovered.path("payload").path("state").asText()).isEqualTo("READY");
            assertThat(recovered.path("payload").path("modelVersion").asText()).isEqualTo("synthetic-v1");
            assertThat(socket.pollEvent(Duration.ofMillis(150))).isNull();
            assertThat(INFERENCE.requestCount()).isEqualTo(2);
        }
    }

    @Test
    void rejectsNonCanonicalInferenceCorrelationAsUnavailable() throws Exception {
        INFERENCE.enqueue(TestInferenceBoundary.ResponsePlan.withNonCanonicalIds());
        JsonNode replay = RealtimeTestFixtures.fixtureTree("active-to-idle.sequence.json", objectMapper);

        try (WebSocketProbe socket = connect()) {
            socket.send(replay.path("startControl").toString());
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            for (int index = 0; index <= 5; index++) {
                socket.send(replay.path("chunks").get(index).toString());
            }
            INFERENCE.awaitCompletedAtLeast(1, WAIT);

            JsonNode unavailable = socket.awaitEvent(
                    event -> event.path("payload").path("state").asText().equals("UNAVAILABLE"), WAIT);
            assertThat(unavailable.path("payload").path("reason").asText())
                    .isEqualTo("SERVICE_UNAVAILABLE");
            assertThat(socket.pollEvent(Duration.ofMillis(150))).isNull();
        }
    }

    @Test
    void rejectsLegacySimulatorInDefaultConfiguration() throws Exception {
        try (WebSocketProbe socket = connect()) {
            socket.send("""
                    {
                      "type": "recognition.result",
                      "sequence": 7,
                      "payload": {"text": "Simulator sentinel", "confidence": 0.93}
                    }
                    """);

            JsonNode status = socket.awaitEvent(reason("INVALID_EVENT"), WAIT);
            assertThat(status.path("payload").path("state").asText()).isEqualTo("INVALID_INPUT");
            assertThat(status.toString()).doesNotContain("Simulator sentinel");
        }
    }

    @Test
    void malformedAndInferenceFailurePathsDoNotExposeFeatureSentinel(
            CapturedOutput output) throws Exception {
        String sentinel = "913579.2468";
        INFERENCE.enqueue(TestInferenceBoundary.ResponsePlan.unavailable());
        JsonNode replay = RealtimeTestFixtures.fixtureTree("active-to-idle.sequence.json", objectMapper);
        ObjectNode malformed = ((ObjectNode) replay.path("chunks").get(0).deepCopy());
        malformed.put("privateSentinel", sentinel);
        for (JsonNode chunk : replay.path("chunks")) {
            ((ArrayNode) chunk.path("frames").get(0).path("features"))
                    .set(0, objectMapper.getNodeFactory().numberNode(913579.2468));
        }

        try (WebSocketProbe socket = connect()) {
            socket.send(malformed.toString());
            JsonNode invalid = socket.awaitEvent(reason("INVALID_EVENT"), WAIT);
            assertThat(invalid.toString()).doesNotContain(sentinel, "features");

            socket.send(replay.path("startControl").toString());
            assertThat(socket.awaitEvent(reason("STARTED"), WAIT)).isNotNull();
            for (int index = 0; index <= 5; index++) {
                socket.send(replay.path("chunks").get(index).toString());
            }
            INFERENCE.awaitCompletedAtLeast(1, WAIT);
            JsonNode unavailable = socket.awaitEvent(
                    event -> event.path("payload").path("state").asText().equals("UNAVAILABLE"), WAIT);
            assertThat(unavailable.toString()).doesNotContain(sentinel, "features");
        }

        assertThat(output.getAll()).doesNotContain(sentinel, "\"features\":[");
    }

    private WebSocketProbe connect() {
        return WebSocketProbe.connect(
                URI.create("ws://localhost:%d/ws/v1/realtime/%s".formatted(port, MEETING_ID)),
                objectMapper,
                WAIT);
    }

    private static Predicate<JsonNode> reason(String reason) {
        return event -> event.path("payload").path("reason").asText().equals(reason);
    }

    private static void assertSafeStatus(JsonNode status) {
        assertThat(status.toString()).doesNotContain(
                "features", "frames", "rawFrame", "videoBase64", "NaN", "-0.45");
        assertThat(status.path("payload").path("message").asText()).hasSizeLessThanOrEqualTo(160);
    }

    private static void shiftFrames(ObjectNode chunk, long firstSequence, double firstTimestamp) {
        ArrayNode frames = (ArrayNode) chunk.path("frames");
        for (int index = 0; index < frames.size(); index++) {
            ObjectNode frame = (ObjectNode) frames.get(index);
            frame.put("sequence", firstSequence + index);
            frame.put("timestampMs", firstTimestamp + index * 40.0);
        }
    }
}

final class RealtimeTestFixtures {

    private RealtimeTestFixtures() {
    }

    static String fixture(String name) throws IOException {
        return Files.readString(contractsRoot().resolve("fixtures").resolve(name));
    }

    static JsonNode fixtureTree(String name, ObjectMapper objectMapper) throws IOException {
        return objectMapper.readTree(fixture(name));
    }

    static Path contractsRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
            Path contracts = candidate.resolve("contracts/sign-recognition/v1");
            if (Files.isDirectory(contracts)) {
                return contracts;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("Could not locate repository recognition contracts");
    }

    static List<String> generatedChunks(
            ObjectMapper objectMapper,
            int firstChunkSequence,
            int count,
            boolean active) throws IOException {
        ObjectNode template = (ObjectNode) fixtureTree(
                active ? "landmark-chunk.valid.json" : "landmark-chunk-idle.valid.json",
                objectMapper);
        List<String> chunks = new ArrayList<>();
        for (int chunkOffset = 0; chunkOffset < count; chunkOffset++) {
            int chunkSequence = firstChunkSequence + chunkOffset;
            ObjectNode chunk = template.deepCopy();
            chunk.put("sequence", chunkSequence);
            ArrayNode frames = (ArrayNode) chunk.path("frames");
            for (int frameOffset = 0; frameOffset < frames.size(); frameOffset++) {
                long frameSequence = chunkSequence * 5L + frameOffset;
                ObjectNode frame = (ObjectNode) frames.get(frameOffset);
                frame.put("sequence", frameSequence);
                frame.put("timestampMs", frameSequence * 40.0);
            }
            chunks.add(chunk.toString());
        }
        return chunks;
    }
}

final class WebSocketProbe implements AutoCloseable {

    private final ObjectMapper objectMapper;
    private final Sinks.Many<String> outbound = Sinks.many().unicast()
            .onBackpressureBuffer(new ArrayBlockingQueue<>(256));
    private final BlockingQueue<String> inbound = new ArrayBlockingQueue<>(256);
    private final AtomicReference<WebSocketSession> session = new AtomicReference<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private final CountDownLatch opened = new CountDownLatch(1);
    private final CountDownLatch closed = new CountDownLatch(1);
    private final Disposable execution;

    private WebSocketProbe(URI endpoint, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.execution = new ReactorNettyWebSocketClient().execute(endpoint, socket -> {
                    session.set(socket);
                    opened.countDown();
                    Mono<Void> sender = socket.send(outbound.asFlux().map(socket::textMessage));
                    Mono<Void> receiver = socket.receive()
                            .filter(message -> message.getType() == WebSocketMessage.Type.TEXT)
                            .map(WebSocketMessage::getPayloadAsText)
                            .doOnNext(message -> {
                                if (!inbound.offer(message)) {
                                    throw new IllegalStateException("Test inbound queue overflowed");
                                }
                            })
                            .then();
                    return Mono.when(sender, receiver);
                })
                .doOnError(failure::set)
                .doFinally(ignored -> closed.countDown())
                .subscribe();
    }

    static WebSocketProbe connect(URI endpoint, ObjectMapper objectMapper, Duration timeout) {
        WebSocketProbe probe = new WebSocketProbe(endpoint, objectMapper);
        probe.awaitLatch(probe.opened, timeout, "WebSocket did not open");
        probe.throwIfFailed();
        return probe;
    }

    void send(String message) {
        Sinks.EmitResult result = outbound.tryEmitNext(message);
        if (result.isFailure()) {
            throw new IllegalStateException("Could not send test WebSocket message: " + result);
        }
    }

    JsonNode awaitEvent(Predicate<JsonNode> predicate, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        List<String> observed = new ArrayList<>();
        while (System.nanoTime() < deadline) {
            throwIfFailed();
            String message;
            try {
                long remaining = Math.max(1L, deadline - System.nanoTime());
                message = inbound.poll(remaining, TimeUnit.NANOSECONDS);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while awaiting WebSocket event", exception);
            }
            if (message == null) {
                break;
            }
            try {
                JsonNode event = objectMapper.readTree(message);
                observed.add("%s/%s/%s".formatted(
                        event.path("type").asText("missing-type"),
                        event.path("payload").path("state").asText("missing-state"),
                        event.path("payload").path("reason").asText("missing-reason")));
                if (predicate.test(event)) {
                    return event;
                }
            } catch (IOException exception) {
                throw new IllegalStateException("Server emitted invalid JSON", exception);
            }
        }
        throwIfFailed();
        throw new AssertionError("Timed out awaiting matching WebSocket event; observed metadata=" + observed);
    }

    JsonNode pollEvent(Duration timeout) {
        throwIfFailed();
        try {
            String message = inbound.poll(timeout.toNanos(), TimeUnit.NANOSECONDS);
            return message == null ? null : objectMapper.readTree(message);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while polling WebSocket event", exception);
        } catch (IOException exception) {
            throw new IllegalStateException("Server emitted invalid JSON", exception);
        }
    }

    void awaitClosed(Duration timeout) {
        awaitLatch(closed, timeout, "WebSocket did not close");
    }

    @Override
    public void close() {
        outbound.tryEmitComplete();
        WebSocketSession current = session.get();
        if (current != null && current.isOpen()) {
            current.close().subscribe();
        }
        awaitLatch(closed, Duration.ofSeconds(2), "WebSocket did not close");
        execution.dispose();
    }

    private void throwIfFailed() {
        Throwable throwable = failure.get();
        if (throwable != null) {
            throw new AssertionError("WebSocket exchange failed", throwable);
        }
    }

    private void awaitLatch(CountDownLatch latch, Duration timeout, String message) {
        try {
            if (!latch.await(timeout.toNanos(), TimeUnit.NANOSECONDS)) {
                throw new AssertionError(message);
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(message, exception);
        }
    }
}

final class TestInferenceBoundary implements AutoCloseable {

    private static final Set<String> REQUEST_FIELDS = Set.of(
            "schemaVersion", "requestId", "streamId", "windowSequence", "frames");
    private static final Set<String> FRAME_FIELDS = Set.of("sequence", "timestampMs", "features");

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ConcurrentLinkedQueue<ResponsePlan> plans = new ConcurrentLinkedQueue<>();
    private final BlockingQueue<RequestSummary> requestSignals = new ArrayBlockingQueue<>(256);
    private final BlockingQueue<Integer> completionSignals = new ArrayBlockingQueue<>(256);
    private final List<RequestSummary> requestSummaries = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final AtomicInteger requestCount = new AtomicInteger();
    private final AtomicInteger completedCount = new AtomicInteger();
    private final AtomicInteger inFlight = new AtomicInteger();
    private final AtomicInteger maximumInFlight = new AtomicInteger();
    private final DisposableServer server;

    private TestInferenceBoundary() {
        this.server = HttpServer.create()
                .host("127.0.0.1")
                .port(0)
                .route(routes -> routes.post("/api/v1/predictions", (request, response) ->
                        request.receive().aggregate().asString(StandardCharsets.UTF_8)
                                .flatMap(body -> handle(body, response))))
                .bindNow(Duration.ofSeconds(5));
    }

    static TestInferenceBoundary start() {
        return new TestInferenceBoundary();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + server.port();
    }

    void reset() {
        plans.clear();
        requestSignals.clear();
        completionSignals.clear();
        requestSummaries.clear();
        requestCount.set(0);
        completedCount.set(0);
        inFlight.set(0);
        maximumInFlight.set(0);
    }

    void enqueue(ResponsePlan... responses) {
        plans.addAll(List.of(responses));
    }

    int requestCount() {
        return requestCount.get();
    }

    int maximumInFlight() {
        return maximumInFlight.get();
    }

    List<RequestSummary> requestSummaries() {
        return List.copyOf(requestSummaries);
    }

    RequestSummary awaitRequest(Duration timeout) {
        RequestSummary summary = pollRequest(timeout);
        if (summary == null) {
            throw new AssertionError("Timed out awaiting inference HTTP request");
        }
        return summary;
    }

    RequestSummary pollRequest(Duration timeout) {
        try {
            return requestSignals.poll(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while awaiting inference request", exception);
        }
    }

    void awaitCompletedAtLeast(int expected, Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (completedCount.get() < expected && System.nanoTime() < deadline) {
            try {
                long remaining = Math.max(1L, deadline - System.nanoTime());
                completionSignals.poll(remaining, TimeUnit.NANOSECONDS);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted while awaiting inference completion", exception);
            }
        }
        if (completedCount.get() < expected) {
            throw new AssertionError("Timed out awaiting " + expected + " inference completions");
        }
    }

    private Mono<Void> handle(String body, reactor.netty.http.server.HttpServerResponse response) {
        int ordinal = requestCount.incrementAndGet();
        int active = inFlight.incrementAndGet();
        maximumInFlight.accumulateAndGet(active, Math::max);

        RequestSummary summary;
        JsonNode request;
        try {
            request = objectMapper.readTree(body);
            summary = summarize(request);
        } catch (Exception exception) {
            request = objectMapper.createObjectNode();
            summary = new RequestSummary(null, null, -1, 0, -1, -1, false);
        }
        requestSummaries.add(summary);
        if (!requestSignals.offer(summary)) {
            throw new IllegalStateException("Test request queue overflowed");
        }

        ResponsePlan plan = plans.poll();
        if (plan == null) {
            plan = ResponsePlan.active();
        }
        ResponsePlan selected = plan;
        JsonNode correlatedRequest = request;
        Mono<Long> delay = selected.delay().isZero()
                ? Mono.just(0L)
                : Mono.delay(selected.delay());

        return selected.releaseSignal().then(delay).then(Mono.defer(() -> {
                    response.status(selected.status());
                    response.header("Content-Type", "application/json");
                    String responseBody = selected.status() == 200
                            ? predictionResponse(correlatedRequest, selected)
                            : "{\"status\":503,\"code\":\"MODEL_UNAVAILABLE\","
                            + "\"message\":\"Inference model is not ready\"}";
                    return response.sendString(Mono.just(responseBody)).then();
                }))
                .doFinally(ignored -> {
                    inFlight.decrementAndGet();
                    completedCount.incrementAndGet();
                    completionSignals.offer(ordinal);
                });
    }

    private RequestSummary summarize(JsonNode request) {
        boolean valid = request.isObject() && fieldNames(request).equals(REQUEST_FIELDS)
                && request.path("schemaVersion").isIntegralNumber()
                && request.path("schemaVersion").asInt() == 1
                && request.path("requestId").isTextual()
                && request.path("streamId").isTextual()
                && request.path("windowSequence").isIntegralNumber()
                && request.path("frames").isArray()
                && request.path("frames").size() == 30;
        long first = -1;
        long last = -1;
        JsonNode frames = request.path("frames");
        if (frames.isArray() && !frames.isEmpty()) {
            first = frames.get(0).path("sequence").asLong(-1);
            last = frames.get(frames.size() - 1).path("sequence").asLong(-1);
            long previousSequence = -1;
            double previousTimestamp = -1;
            for (JsonNode frame : frames) {
                boolean frameValid = frame.isObject() && fieldNames(frame).equals(FRAME_FIELDS)
                        && frame.path("sequence").isIntegralNumber()
                        && frame.path("timestampMs").isNumber()
                        && frame.path("features").isArray()
                        && frame.path("features").size() == 224
                        && frame.path("sequence").asLong() > previousSequence
                        && frame.path("timestampMs").asDouble() > previousTimestamp;
                valid &= frameValid;
                previousSequence = frame.path("sequence").asLong();
                previousTimestamp = frame.path("timestampMs").asDouble();
            }
        }
        return new RequestSummary(
                request.path("requestId").textValue(),
                request.path("streamId").textValue(),
                request.path("windowSequence").asLong(-1),
                frames.isArray() ? frames.size() : 0,
                first,
                last,
                valid);
    }

    private String predictionResponse(JsonNode request, ResponsePlan plan) {
        try {
            ObjectNode response = (ObjectNode) objectMapper.readTree(RealtimeTestFixtures.fixture(
                    "NO_SIGN".equals(plan.labelId())
                            ? "inference-response-idle.valid.json"
                            : "inference-response-active.valid.json"));
            response.put("requestId", request.path("requestId").asText());
            response.put("streamId", request.path("streamId").asText());
            if (plan.nonCanonicalIds()) {
                response.put("requestId", base64Uuid(response.path("requestId").asText()));
                response.put("streamId", base64Uuid(response.path("streamId").asText()));
            }
            response.put("windowSequence", request.path("windowSequence").asLong());
            response.put("labelId", plan.labelId());
            if (plan.captionText() == null) {
                response.putNull("captionText");
            } else {
                response.put("captionText", plan.captionText());
            }
            response.put("confidence", plan.confidence());
            return objectMapper.writeValueAsString(response);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not build test inference response", exception);
        }
    }

    private static Set<String> fieldNames(JsonNode node) {
        Set<String> names = new HashSet<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    private static String base64Uuid(String canonicalUuid) {
        java.util.UUID uuid = java.util.UUID.fromString(canonicalUuid);
        return Base64.getEncoder().encodeToString(ByteBuffer.allocate(16)
                .putLong(uuid.getMostSignificantBits())
                .putLong(uuid.getLeastSignificantBits())
                .array());
    }

    @Override
    public void close() {
        server.disposeNow(Duration.ofSeconds(5));
    }

    record RequestSummary(
            String requestId,
            String streamId,
            long windowSequence,
            int frameCount,
            long firstFrameSequence,
            long lastFrameSequence,
            boolean validContract) {
    }

    record ResponsePlan(
            int status,
            String labelId,
            String captionText,
            double confidence,
            Duration delay,
            boolean nonCanonicalIds,
            Sinks.Empty<Void> releaseGate) {

        static ResponsePlan active() {
            return new ResponsePlan(
                    200, "MOCK_ACTIVE", "Synthetic active gesture", 0.95, Duration.ZERO, false, null);
        }

        static ResponsePlan pausedActive() {
            return new ResponsePlan(
                    200, "MOCK_ACTIVE", "Synthetic active gesture", 0.95, Duration.ZERO, false,
                    Sinks.empty());
        }

        static ResponsePlan idle() {
            return new ResponsePlan(200, "NO_SIGN", null, 0.99, Duration.ZERO, false, null);
        }

        static ResponsePlan lowConfidence() {
            return new ResponsePlan(
                    200, "MOCK_ACTIVE", "Synthetic active gesture", 0.42, Duration.ZERO, false, null);
        }

        static ResponsePlan label(String labelId, String captionText) {
            return new ResponsePlan(200, labelId, captionText, 0.95, Duration.ZERO, false, null);
        }

        static ResponsePlan delayedActive(Duration delay) {
            return new ResponsePlan(200, "MOCK_ACTIVE", "Synthetic active gesture", 0.95, delay, false, null);
        }

        static ResponsePlan delayedLabel(String labelId, String captionText, Duration delay) {
            return new ResponsePlan(200, labelId, captionText, 0.95, delay, false, null);
        }

        static ResponsePlan unavailable() {
            return new ResponsePlan(503, "NO_SIGN", null, 0.0, Duration.ZERO, false, null);
        }

        static ResponsePlan withNonCanonicalIds() {
            return new ResponsePlan(
                    200, "MOCK_ACTIVE", "Synthetic active gesture", 0.95, Duration.ZERO, true, null);
        }

        Mono<Void> releaseSignal() {
            return releaseGate == null ? Mono.empty() : releaseGate.asMono();
        }

        void release() {
            if (releaseGate != null) {
                releaseGate.tryEmitEmpty();
            }
        }
    }
}
