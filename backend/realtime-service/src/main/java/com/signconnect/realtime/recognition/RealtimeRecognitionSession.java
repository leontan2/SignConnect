package com.signconnect.realtime.recognition;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.signconnect.realtime.api.CaptionEvent;
import com.signconnect.realtime.api.CaptionPayload;
import com.signconnect.realtime.api.LandmarkChunkEvent;
import com.signconnect.realtime.api.RecognitionControlEvent;
import com.signconnect.realtime.api.RecognitionResultEvent;
import com.signconnect.realtime.api.RecognitionStatusEvent;
import com.signconnect.realtime.api.RecognitionUnknownEvent;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.inference.InferenceClient;
import com.signconnect.realtime.inference.InferenceClient.InferenceUnavailableException;
import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class RealtimeRecognitionSession {

    private static final int SERVER_EVENT_QUEUE_CAPACITY = 64;
    private static final int UNKNOWN_EVALUATION_COUNT = 3;
    private static final UUID SIMULATOR_STREAM_ID = UUID.fromString(
            "00000000-0000-4000-8000-000000000000");

    private final UUID meetingId;
    private final ObjectMapper objectMapper;
    private final RecognitionProperties properties;
    private final InferenceClient inferenceClient;
    private final Clock clock;
    private final Scheduler trackingScheduler;
    private final boolean developmentProfileActive;
    private final RollingLandmarkWindow rollingWindow;
    private final RecognitionStabilizer stabilizer;
    private final Sinks.Many<String> outbound = Sinks.many().unicast()
            .onBackpressureBuffer(new ArrayBlockingQueue<>(SERVER_EVENT_QUEUE_CAPACITY));

    private UUID currentStreamId;
    private boolean recognitionActive;
    private long generation;
    private long nextServerSequence;
    private long expectedChunkSequence;
    private long lastControlSequence;
    private double lastControlTimestamp;
    private Long lastFrameSequence;
    private Double lastFrameTimestamp;
    private Instant lastChunkReceivedAt;
    private long streamGeneration;
    private long trackingTimeoutToken;
    private Disposable trackingTimeoutTask;
    private boolean inferenceInFlight;
    private Candidate pendingCandidate;
    private Candidate inFlightCandidate;
    private Disposable inFlightSubscription;
    private boolean inferenceUnavailable;
    private boolean closed;

    public RealtimeRecognitionSession(
            UUID meetingId,
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            Clock clock) {
        this(meetingId, objectMapper, properties, inferenceClient, clock, Schedulers.parallel(), false);
    }

    public RealtimeRecognitionSession(
            UUID meetingId,
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            Clock clock,
            boolean developmentProfileActive) {
        this(
                meetingId,
                objectMapper,
                properties,
                inferenceClient,
                clock,
                Schedulers.parallel(),
                developmentProfileActive);
    }

    public RealtimeRecognitionSession(
            UUID meetingId,
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            Clock clock,
            Scheduler trackingScheduler) {
        this(meetingId, objectMapper, properties, inferenceClient, clock, trackingScheduler, false);
    }

    public RealtimeRecognitionSession(
            UUID meetingId,
            ObjectMapper objectMapper,
            RecognitionProperties properties,
            InferenceClient inferenceClient,
            Clock clock,
            Scheduler trackingScheduler,
            boolean developmentProfileActive) {
        this.meetingId = Objects.requireNonNull(meetingId, "meetingId");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper");
        this.properties = Objects.requireNonNull(properties, "properties");
        this.inferenceClient = Objects.requireNonNull(inferenceClient, "inferenceClient");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.trackingScheduler = Objects.requireNonNull(trackingScheduler, "trackingScheduler");
        this.developmentProfileActive = developmentProfileActive;
        this.rollingWindow = new RollingLandmarkWindow(
                properties.getWindowFrames(), properties.getStrideFrames());
        this.stabilizer = new RecognitionStabilizer(
                clock,
                new RecognitionStabilizer.Settings(
                        properties.getConfidenceThreshold(),
                        properties.getStableActiveEvaluations(),
                        properties.getIdleEvaluations(),
                        properties.getDuplicateCooldown(),
                        UNKNOWN_EVALUATION_COUNT,
                        properties.getUnknownRateLimit()));
    }

    public Flux<String> outboundMessages() {
        return outbound.asFlux();
    }

    /**
     * Accepts one recognition message.
     *
     * @return true only when this message validly stopped the active stream
     */
    public synchronized boolean acceptText(String message, int byteCount) {
        if (closed) {
            return false;
        }
        if (byteCount > properties.getMaxMessageSize().toBytes()) {
            emitProtocolStatus(null, "INVALID_EVENT", "Recognition message exceeded the allowed size.");
            return false;
        }

        JsonNode root;
        try {
            root = objectMapper.reader().readTree(message);
        } catch (JsonProcessingException exception) {
            emitProtocolStatus(null, "INVALID_EVENT", "Recognition input was rejected.");
            return false;
        }
        if (root == null || !root.isObject() || !root.path("type").isTextual()) {
            emitProtocolStatus(streamIdFrom(root), "INVALID_EVENT", "Recognition input was rejected.");
            return false;
        }

        String type = root.path("type").asText();
        if ("recognition.result".equals(type)) {
            handleSimulator(root);
            return false;
        }
        if (!root.path("schemaVersion").isIntegralNumber()) {
            emitProtocolStatus(streamIdFrom(root), "INVALID_EVENT", "Recognition input was rejected.");
            return false;
        }
        if (root.path("schemaVersion").asInt() != LandmarkChunkEvent.SCHEMA_VERSION) {
            emitProtocolStatus(streamIdFrom(root), "UNSUPPORTED_VERSION", "Recognition version is unsupported.");
            return false;
        }

        try {
            if ("recognition.control".equals(type)) {
                return handleControl(objectMapper.treeToValue(root, RecognitionControlEvent.class));
            }
            if ("landmark.chunk".equals(type)) {
                handleChunk(objectMapper.treeToValue(root, LandmarkChunkEvent.class));
            } else {
                emitProtocolStatus(streamIdFrom(root), "INVALID_EVENT", "Recognition event type is unsupported.");
            }
        } catch (JsonProcessingException | IllegalArgumentException exception) {
            emitProtocolStatus(streamIdFrom(root), "INVALID_EVENT", "Recognition input was rejected.");
        }
        return false;
    }

    public synchronized void acceptNonText() {
        if (!closed) {
            emitProtocolStatus(currentStreamId, "INVALID_EVENT", "Only text recognition events are accepted.");
        }
    }

    public synchronized void close() {
        if (closed) {
            return;
        }
        closed = true;
        resetPipeline();
        outbound.tryEmitComplete();
    }

    public synchronized void releaseOwnership() {
        if (closed) {
            return;
        }
        resetPipeline();
        recognitionActive = false;
        currentStreamId = null;
        lastFrameSequence = null;
        lastFrameTimestamp = null;
        lastChunkReceivedAt = null;
    }

    private boolean handleControl(RecognitionControlEvent control) {
        if (!control.hasValidContract()) {
            emitProtocolStatus(control.streamId(), "INVALID_EVENT", "Recognition control was rejected.");
            return false;
        }
        if ("start".equals(control.action())) {
            if (control.sequence() != 0) {
                emitProtocolStatus(control.streamId(), "OUT_OF_ORDER", "Recognition control is out of order.");
                return false;
            }
            startStream(control);
            return false;
        }
        return stopStream(control);
    }

    private void startStream(RecognitionControlEvent control) {
        resetPipeline();
        currentStreamId = control.streamId();
        recognitionActive = true;
        expectedChunkSequence = 0;
        lastControlSequence = control.sequence();
        lastControlTimestamp = control.timestampMs();
        lastFrameSequence = null;
        lastFrameTimestamp = null;
        // Model/worker startup happens after consent and is not a tracking gap. The timeout
        // begins only once this stream has supplied its first accepted landmark chunk.
        lastChunkReceivedAt = null;
        inferenceUnavailable = false;
        emitStatus(
                currentStreamId,
                "READY",
                "STARTED",
                "Recognition is ready.",
                null,
                null);
    }

    private boolean stopStream(RecognitionControlEvent control) {
        if (!recognitionActive
                || !control.streamId().equals(currentStreamId)
                || control.sequence() != lastControlSequence + 1
                || control.timestampMs() <= lastControlTimestamp) {
            emitProtocolStatus(control.streamId(), "OUT_OF_ORDER", "Recognition control is out of order.");
            return false;
        }
        UUID stoppedStream = currentStreamId;
        emitStatus(
                stoppedStream,
                "STOPPED",
                "STOPPED_BY_CLIENT",
                "Recognition stopped.",
                null,
                null);
        resetPipeline();
        recognitionActive = false;
        currentStreamId = null;
        lastFrameSequence = null;
        lastFrameTimestamp = null;
        lastChunkReceivedAt = null;
        return true;
    }

    private void handleChunk(LandmarkChunkEvent chunk) {
        if (!chunk.hasValidContract()) {
            if (recognitionActive && chunk.streamId() != null && chunk.streamId().equals(currentStreamId)) {
                resetPipeline();
            }
            emitProtocolStatus(chunk.streamId(), "INVALID_EVENT", "Landmark chunk was rejected.");
            return;
        }
        if (!recognitionActive || !chunk.streamId().equals(currentStreamId)) {
            emitProtocolStatus(chunk.streamId(), "INVALID_EVENT", "Recognition stream is not active.");
            return;
        }

        Instant now = clock.instant();
        if (lastChunkReceivedAt != null) {
            Duration idle = Duration.between(lastChunkReceivedAt, now);
            if (!idle.isNegative() && idle.compareTo(properties.getTrackingTimeout()) > 0) {
                resetPipeline();
                expectedChunkSequence = chunk.sequence() + 1;
                LandmarkChunkEvent.Frame last = chunk.frames().getLast();
                lastFrameSequence = last.sequence();
                lastFrameTimestamp = last.timestampMs();
                lastChunkReceivedAt = now;
                emitProtocolStatus(currentStreamId, "OUT_OF_ORDER", "Tracking continuity was reset.");
                return;
            }
        }

        LandmarkChunkEvent.Frame first = chunk.frames().getFirst();
        boolean chunkSequenceMatches = chunk.sequence() == expectedChunkSequence;
        boolean frameSequenceMatches = lastFrameSequence == null
                ? first.sequence() == 0
                : first.sequence() == lastFrameSequence + 1;
        boolean timestampMatches = lastFrameTimestamp == null || first.timestampMs() > lastFrameTimestamp;
        if (!chunkSequenceMatches || !frameSequenceMatches || !timestampMatches) {
            resetPipeline();
            expectedChunkSequence = chunk.sequence() + 1;
            LandmarkChunkEvent.Frame last = chunk.frames().getLast();
            lastFrameSequence = last.sequence();
            lastFrameTimestamp = last.timestampMs();
            lastChunkReceivedAt = now;
            emitProtocolStatus(currentStreamId, "OUT_OF_ORDER", "Recognition stream order was reset.");
            return;
        }

        expectedChunkSequence++;
        LandmarkChunkEvent.Frame last = chunk.frames().getLast();
        lastFrameSequence = last.sequence();
        lastFrameTimestamp = last.timestampMs();
        lastChunkReceivedAt = now;
        scheduleTrackingTimeout();
        for (RollingLandmarkWindow.Window completed : rollingWindow.append(chunk.frames())) {
            enqueueInference(new Candidate(generation, currentStreamId, completed));
        }
    }

    private void handleSimulator(JsonNode root) {
        if (!developmentProfileActive || !properties.isSimulatorEnabled()) {
            emitProtocolStatus(streamIdFrom(root), "INVALID_EVENT", "Simulator input is disabled.");
            return;
        }
        try {
            RecognitionResultEvent result = objectMapper.treeToValue(root, RecognitionResultEvent.class);
            if (!"recognition.result".equals(result.type())
                    || result.sequence() < 0
                    || result.payload() == null
                    || result.payload().text() == null
                    || result.payload().text().isBlank()
                    || result.payload().text().length() > 240
                    || !Double.isFinite(result.payload().confidence())
                    || result.payload().confidence() < 0.0
                    || result.payload().confidence() > 1.0) {
                emitProtocolStatus(null, "INVALID_EVENT", "Simulator input was rejected.");
                return;
            }
            emit(new CaptionEvent(
                    1,
                    "caption.final",
                    meetingId,
                    SIMULATOR_STREAM_ID,
                    nextServerSequence++,
                    new CaptionPayload(
                            "SIMULATOR",
                            result.payload().text(),
                            result.payload().confidence(),
                            "simulator-v1",
                            0.0,
                            true),
                    clock.instant()));
        } catch (JsonProcessingException exception) {
            emitProtocolStatus(null, "INVALID_EVENT", "Simulator input was rejected.");
        }
    }

    private void enqueueInference(Candidate candidate) {
        if (inferenceInFlight) {
            pendingCandidate = candidate;
            return;
        }
        inferenceInFlight = true;
        startInference(candidate);
    }

    private void startInference(Candidate candidate) {
        inFlightCandidate = candidate;
        Disposable subscription = inferenceClient.predict(candidate.streamId(), candidate.window())
                .subscribe(
                        prediction -> completeInference(candidate, prediction, null),
                        error -> completeInference(candidate, null, error));
        if (inFlightCandidate == candidate) {
            inFlightSubscription = subscription;
        }
    }

    private synchronized void completeInference(
            Candidate candidate,
            InferenceClient.Prediction prediction,
            Throwable failure) {
        if (closed || inFlightCandidate != candidate) {
            return;
        }
        boolean current = candidate.generation() == generation
                && recognitionActive
                && candidate.streamId().equals(currentStreamId);
        if (current) {
            if (failure != null) {
                handleInferenceFailure(failure);
                return;
            }
            handlePrediction(candidate, prediction);
        }

        inferenceInFlight = false;
        inFlightCandidate = null;
        inFlightSubscription = null;
        Candidate next = pendingCandidate;
        pendingCandidate = null;
        if (next != null
                && next.generation() == generation
                && recognitionActive
                && next.streamId().equals(currentStreamId)) {
            inferenceInFlight = true;
            startInference(next);
        }
    }

    private void handlePrediction(Candidate candidate, InferenceClient.Prediction prediction) {
        if (inferenceUnavailable) {
            inferenceUnavailable = false;
            emitStatus(
                    currentStreamId,
                    "READY",
                    "RECOVERED",
                    "Recognition is available again.",
                    prediction.modelVersion(),
                    prediction.mockModel());
        }
        RecognitionStabilizer.Outcome outcome = stabilizer.evaluate(
                new RecognitionStabilizer.Prediction(
                        prediction.schemaVersion(),
                        prediction.requestId(),
                        prediction.streamId(),
                        prediction.windowSequence(),
                        prediction.labelId(),
                        prediction.captionText(),
                        prediction.confidence(),
                        prediction.modelVersion(),
                        prediction.inferenceLatencyMs(),
                        prediction.mockModel()),
                candidate.window().recentHandPresent());
        if (outcome instanceof RecognitionStabilizer.Final completed) {
            RecognitionStabilizer.Prediction result = completed.prediction();
            emit(new CaptionEvent(
                    1,
                    "caption.final",
                    meetingId,
                    result.streamId(),
                    nextServerSequence++,
                    new CaptionPayload(
                            result.labelId(),
                            result.captionText(),
                            result.confidence(),
                            result.modelVersion(),
                            result.inferenceLatencyMs(),
                            result.mockModel()),
                    completed.occurredAt()));
        } else if (outcome instanceof RecognitionStabilizer.Unknown unknown) {
            RecognitionStabilizer.Prediction result = unknown.prediction();
            emit(new RecognitionUnknownEvent(
                    1,
                    "recognition.unknown",
                    meetingId,
                    result.streamId(),
                    nextServerSequence++,
                    new RecognitionUnknownEvent.Payload(
                            unknown.reason().name(),
                            result.confidence(),
                            result.modelVersion(),
                            result.inferenceLatencyMs(),
                            result.mockModel()),
                    unknown.occurredAt()));
        }
    }

    private void handleInferenceFailure(Throwable failure) {
        boolean firstFailure = !inferenceUnavailable;
        inferenceUnavailable = true;
        resetRecognitionState();
        if (!firstFailure) {
            return;
        }
        String reason = failure instanceof InferenceUnavailableException unavailable
                && unavailable.reason() == InferenceClient.FailureReason.TIMEOUT
                ? "TIMEOUT"
                : "SERVICE_UNAVAILABLE";
        emitStatus(
                currentStreamId,
                "UNAVAILABLE",
                reason,
                "Recognition is temporarily unavailable.",
                null,
                null);
    }

    private void resetPipeline() {
        cancelTrackingTimeout();
        streamGeneration++;
        resetRecognitionState();
    }

    private void resetRecognitionState() {
        generation++;
        pendingCandidate = null;
        Disposable staleSubscription = inFlightSubscription;
        inFlightCandidate = null;
        inFlightSubscription = null;
        inferenceInFlight = false;
        rollingWindow.reset();
        stabilizer.reset();
        if (staleSubscription != null) {
            staleSubscription.dispose();
        }
    }

    private void scheduleTrackingTimeout() {
        Disposable previousTask = trackingTimeoutTask;
        trackingTimeoutTask = null;
        if (previousTask != null) {
            previousTask.dispose();
        }
        long scheduledToken = ++trackingTimeoutToken;
        long scheduledStreamGeneration = streamGeneration;
        UUID scheduledStreamId = currentStreamId;
        trackingTimeoutTask = trackingScheduler.schedule(
                () -> handleTrackingTimeout(
                        scheduledStreamId,
                        scheduledStreamGeneration,
                        scheduledToken),
                properties.getTrackingTimeout().toNanos(),
                TimeUnit.NANOSECONDS);
    }

    private synchronized void handleTrackingTimeout(
            UUID scheduledStreamId,
            long scheduledStreamGeneration,
            long scheduledToken) {
        if (closed
                || !recognitionActive
                || scheduledStreamGeneration != streamGeneration
                || scheduledToken != trackingTimeoutToken
                || !scheduledStreamId.equals(currentStreamId)) {
            return;
        }

        trackingTimeoutTask = null;
        trackingTimeoutToken++;
        lastChunkReceivedAt = null;
        resetRecognitionState();
        emitProtocolStatus(currentStreamId, "OUT_OF_ORDER", "Tracking continuity was reset.");
    }

    private void cancelTrackingTimeout() {
        trackingTimeoutToken++;
        Disposable staleTask = trackingTimeoutTask;
        trackingTimeoutTask = null;
        if (staleTask != null) {
            staleTask.dispose();
        }
    }

    private void emitProtocolStatus(UUID streamId, String reason, String message) {
        emitStatus(streamId, "INVALID_INPUT", reason, message, null, null);
    }

    private void emitStatus(
            UUID streamId,
            String state,
            String reason,
            String message,
            String modelVersion,
            Boolean mockModel) {
        emit(new RecognitionStatusEvent(
                1,
                "recognition.status",
                meetingId,
                streamId,
                nextServerSequence++,
                new RecognitionStatusEvent.Payload(state, reason, message, modelVersion, mockModel),
                clock.instant()));
    }

    private void emit(Object event) {
        try {
            Sinks.EmitResult result = outbound.tryEmitNext(objectMapper.writeValueAsString(event));
            if (result.isFailure() && result != Sinks.EmitResult.FAIL_CANCELLED) {
                outbound.tryEmitError(new IllegalStateException("Recognition output queue is unavailable"));
            }
        } catch (JsonProcessingException exception) {
            outbound.tryEmitError(new IllegalStateException("Could not serialize recognition event"));
        }
    }

    private static UUID streamIdFrom(JsonNode root) {
        if (root == null || !root.path("streamId").isTextual()) {
            return null;
        }
        return LandmarkChunkEvent.parseCanonicalUuid(root.path("streamId").asText());
    }

    private record Candidate(
            long generation,
            UUID streamId,
            RollingLandmarkWindow.Window window) {
    }
}
