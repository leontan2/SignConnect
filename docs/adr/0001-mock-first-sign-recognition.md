# ADR-0001: Use a mock-first Java sign-recognition path

**Date**: 2026-08-29
**Status**: accepted
**Deciders**: SignConnect product and engineering

## Context

SignConnect currently turns a development-only `recognition.result` message into a final caption on the same WebSocket connection. The recognition MVP must prove the complete landmark-to-caption integration without representing a synthetic model or an unreviewed vocabulary as valid Singapore Sign Language (SGSL) recognition. It also needs a narrow privacy boundary: raw video stays in the browser, while the derived landmark and tensor data needed for inference remains transient.

The README's Python/gRPC model-serving sketch describes a possible future state, not this milestone. The current backend is Java 21 and Spring Boot, and the existing meeting path already uses WebSocket, so a Java/HTTP/ONNX design gives this vertical slice the fewest new runtime boundaries.

## Decision

We use a mock-first, same-client pipeline: browser MediaPipe extraction sends versioned landmark chunks over the meeting's existing WebSocket; the Java realtime service builds and stabilizes windows; it calls a Java Spring Boot inference service over HTTP; and the inference service executes a deterministic synthetic model with ONNX Runtime Java CPU. A finalized caption returns only on the WebSocket connection that submitted the landmarks.

This decision freezes the following v1 behavior.

### Browser capture and feature contract

- Camera preview and recognition transmission are separate controls. Recognition begins only after an explicit Start action and disclosure that hand/body landmarks, but not video, are transmitted.
- The model source is unmirrored. CSS may mirror the local preview, but must not change anatomical left/right slots or model coordinates.
- MediaPipe Hand Landmarker and Pose Landmarker run in a dedicated worker. Capture targets 25 processed frames per second; the acceptable measured range is 20-30 FPS.
- At most one MediaPipe frame is in flight. While the worker is busy, the browser skips or delays additional animation frames instead of queueing them.
- Each frame has exactly 224 finite numeric features. Point order is anatomical left hand landmarks 0-20, anatomical right hand landmarks 0-20, then pose landmarks 11-24. Each point contributes `x`, `y`, `z`, then `presence` (`0` or `1`).
- Coordinates are normalized around the shoulder midpoint and scaled by shoulder width. A missing point has zero coordinates and `presence=0`. Frames without adequate pose anchors are dropped; an adequately tracked pose-only frame with no hands is a valid idle candidate.
- A `landmark.chunk` contains exactly five accepted or idle frames. Schema version is `1`; `streamId` is a UUID; chunk `sequence` and each frame's `sequence` and `timestampMs` are non-negative and strictly monotonic within their scope; each frame carries only `sequence`, `timestampMs`, and `features`.
- The browser bounds socket-pressure memory. It retains at most the newest unsent complete five-frame batch and replaces an older pending batch rather than building a queue.
- Stopping recognition, turning off or replacing the camera stream, or unmounting the meeting releases frame/worker resources and stops transmission.

### WebSocket ownership, ordering, and windows

- The version 1 `recognition.control` start action initializes one recognition stream; stop releases it. Its control sequence and timestamp follow the same non-negative monotonic ordering rule. State is isolated by WebSocket connection and `streamId`, and no state or result is broadcast to a room.
- A reconnect creates a new `streamId`, resets chunk and window sequences, and prevents results from the prior connection from becoming captions. Transmission resumes only when the user had explicitly left recognition enabled.
- The realtime service rejects unsupported versions, malformed or oversized messages, non-finite or incorrectly sized frames, and out-of-order chunks. It resets stream state on stop, reconnect or a new stream, an invalid sequence discontinuity, or the configured tracking timeout.
- The realtime service owns a rolling 30-frame window with tensor shape `[1,30,224]`. Frames remain in strictly increasing frame-sequence and timestamp order. The service evaluates at five-frame strides, once for each newly completed chunk after a full window exists.
- Each connection has at most one inference request in flight. If another complete window becomes available while inference is busy, it replaces the pending candidate; only the latest complete window is eligible to run. Superseded or stale windows are neither retried nor allowed to emit captions.
- Inference `requestId`, `streamId`, and monotonically increasing `windowSequence` correlate responses to the active stream. Late responses whose stream or window is no longer current are discarded.

### Java HTTP and ONNX inference

- `sign-inference-service` is a Java 21, Spring Boot 3.5.16 service. The realtime service calls `POST /api/v1/predictions` over HTTP, not gRPC, with the versioned 30-by-224 window and ordering identifiers.
- The live inference timeout is 500 ms. There is no automatic retry of a stale window, and a timeout is a status/error condition, never a caption.
- The inference service uses ONNX Runtime Java CPU 1.29.0 and owns exactly one `OrtEnvironment` and one loaded `OrtSession` per application context. They live until application shutdown rather than being created per request.
- Startup validates the `[1,30,224]` finite-float input, output rank and label count, label-map consistency, and model version. ONNX mode fails readiness and refuses predictions when its artifact is absent or invalid; it never silently falls back to mock behavior.
- This milestone's artifact is a license-safe deterministic synthetic ONNX model and label map. Every inference response and caption metadata identifies the mock model, and the product visibly distinguishes its output from validated SGSL recognition.

### Stabilization, idle, cooldown, and events

- Stabilization thresholds are configurable, with deterministic defaults. A non-idle label becomes stable only after three consecutive evaluations of that same label at confidence greater than or equal to `0.80`.
- A stable label finalizes only after two consecutive `NO_SIGN`/idle evaluations. A held prediction cannot repeatedly finalize.
- The realtime service emits exactly one `caption.final` for each finalized occurrence. A genuine repeat of the same label is eligible only after idle separation and the default 1.5-second duplicate cooldown.
- Repeated tracked activity that does not meet the final threshold may produce `recognition.unknown`, rate-limited to at most once every two seconds. Unknown events never enter the transcript.
- Inference unavailable, timeout, and recovery conditions produce typed recognition status events. They do not produce partial or final captions.
- Public server output is limited to `caption.final`, rate-limited `recognition.unknown`, and typed recognition status/control events. Every event's non-negative `sequence` increases on the submitting WebSocket connection. A `caption.final` envelope carries `schemaVersion`, `type`, `meetingId`, `streamId`, `sequence`, `payload`, and `occurredAt`; its payload carries `labelId`, `text`, `confidence`, `modelVersion`, `inferenceLatencyMs`, and `mockModel`.

### Development simulator

The legacy `recognition.result` path and simulator UI remain development-only. The UI requires an explicit development build flag and the server requires an explicit development profile; production/default behavior hides the simulator and rejects its input. No production fallback may enable it implicitly.

### Privacy boundary

Raw frames and pixels remain browser-local and are never serialized to WebSocket or HTTP, analytics, logs, or storage. Landmark coordinates, presence values, flattened feature arrays, rolling windows, and inference tensors are sensitive derived data used only transiently in memory. They must never be persisted or included in request-body logs, application or `toString` logs, exception text, trace attributes/events, or metric labels. The detailed lifecycle and operational controls are recorded in `docs/privacy/sign-recognition-data-boundary.md`.

### Mock-first definition of done

The milestone is complete when a consented deterministic fixture traverses the real browser-compatible normalization and chunk contract, the existing meeting WebSocket, bounded realtime windowing, the inference service's singleton ONNX Runtime Java session, stable-label-plus-idle finalization, and same-client delivery of exactly one `caption.final`. It must also demonstrate bounded buffers, deterministic duplicate/unknown behavior, reconnect and inference-unavailable handling, and local p95 below one second from the first injected idle/completion frame to caption receipt/render. The simulator must be unavailable unless both development controls are enabled, and tests must show that raw frames never leave the browser and landmark/tensor sentinel values never enter captured logs.

This definition of done proves integration only. It does not assert that a human performing an SGSL sign will be recognized.

## Alternatives Considered

### Python service over gRPC

- **Pros**: Aligns with the README's broad ML future-state sketch and a common training ecosystem.
- **Cons**: Adds a second backend language, gRPC contracts, and deployment/tooling work that the deterministic vertical slice does not require.
- **Why not**: This milestone needs to validate the existing Java/WebSocket path with minimal new runtime surface. A future qualified model may revisit the serving boundary through a new ADR.

### Run ONNX inference entirely in the browser

- **Pros**: Keeps derived data client-side and removes a server network hop.
- **Cons**: Does not exercise the required realtime orchestration and Java model-service boundary, and shifts model/runtime cost and compatibility into the browser.
- **Why not**: The agreed v1 assigns windows, backpressure, stabilization, and finalization to the realtime service and requires a Java ONNX integration slice.

### Send raw video to the backend

- **Pros**: Would permit centralized preprocessing and future feature extraction changes.
- **Cons**: Materially expands the privacy, security, bandwidth, consent, and retention boundary.
- **Why not**: The product decision is that raw video never leaves the browser.

### Emit a caption for each model prediction

- **Pros**: Simpler implementation and lower apparent latency.
- **Cons**: Produces duplicate and unstable captions and cannot distinguish a held sign from a completed occurrence.
- **Why not**: V1 requires deterministic stable-label-plus-idle finalization, cooldown, and unknown handling.

## Consequences

### Positive

- The milestone tests the actual transport, ordering, window, HTTP, tensor, ONNX Runtime, and caption path without waiting for linguistic review or a real dataset.
- Same-client delivery and transient derived-data handling keep the first privacy and state boundary narrow.
- Fixed windowing and stabilization rules make frontend and Java contract fixtures deterministic and reusable.

### Negative

- Server inference adds an HTTP hop and requires explicit overload, timeout, readiness, and cleanup behavior.
- Five-frame chunking and 30-frame windows impose unavoidable buffering before a caption can finalize.
- The synthetic model cannot establish real-world accuracy or SGSL suitability.

### Risks

- **Mock output mistaken for SGSL recognition**: carry a mock-model marker end to end, show it in the UI, and prohibit quality claims.
- **Backpressure produces stale captions**: enforce one in-flight operation, latest-complete-window replacement, ordering checks, and no stale retries.
- **Sensitive values leak through diagnostics**: prohibit body/value logging across every service and verify with sentinel log tests.
- **Reconnect or discontinuity mixes streams**: create a new UUID stream, reset all sequences/windows/stabilization, and discard old results.

## Explicit Deferrals

The following are not part of this ADR's milestone:

- room broadcast, multiple simultaneous signer streams, late-join replay, and caption persistence;
- real signer data collection or labeling, real-model training, and production model qualification;
- facial, face-mesh, expression, or other non-manual features;
- partial captions, continuous translation, and sentence construction;
- mobile support and Firefox or Safari acceptance; the required baseline is current desktop Chrome and Edge on Windows and macOS;
- any model-quality, linguistic-validity, or approved-SGSL claim;
- GPU/TensorRT inference, model registries, DVC, MLflow, Redis/NATS orchestration, Kubernetes deployment, and a new authentication architecture.

The real-model milestone is gated on all of the following: SGSL-fluent review of vocabulary/gloss/caption mappings and excluded non-manual requirements; licensed and consented multi-signer recordings with documented usage terms; training data that includes supported signs, `NO_SIGN`, transitions, and unknown/negative examples with signer-independent splits; an exported model that preserves the v1 contracts and reaches at least 80% signer-independent macro-F1 with no more than a 5% false-final rate on `NO_SIGN`/unknown samples; and an updated disclosure and model card describing vocabulary, population limits, failure modes, and measured performance.
