# Sign Recognition Data Boundary

## Purpose

This document defines the allowed data flow for the mock-first isolated-sign recognition MVP. It applies to the Meeting MFE, MediaPipe worker, meeting WebSocket, realtime service, inference HTTP client, sign inference service, ONNX Runtime integration, tests, and observability configuration.

Recognition is opt-in and separate from camera preview. The user must explicitly start it after seeing a disclosure that normalized hand and upper-body landmarks are transmitted while raw video is not.

This document governs the live meeting and inference path. It does not authorize dataset capture or model training. Any development-only training capture is a separate local workflow governed by [ADR-0003](../adr/0003-training-data-capture-boundary.md) and may operate only after its consent, SGSL review, retention, deletion, and repository-guard prerequisites pass.

## Boundary Summary

| Data | Permitted locations and use | Prohibited destinations or use |
| --- | --- | --- |
| Raw camera frames, pixels, and browser frame objects | Browser camera/preview and MediaPipe worker only; release immediately after processing | WebSocket, HTTP, logs, analytics, traces, metrics, persistence, fixtures captured from users, or any server |
| Landmark values and flattened frame features | Transient browser buffers, the submitting WebSocket, transient realtime stream/window state, and the inference request | Databases, files, object storage, caches, queues, replay/dead-letter systems, logs, exception text, traces, metric labels, analytics, or room broadcast |
| 30-by-224 windows and ONNX tensors | Transient realtime request state and inference-process memory for the active call | Persistence, request/response-body logging, dumps, diagnostic output, traces, metric labels, analytics, or training-data collection |
| Prediction and caption payloads | Inference response and recognition feedback on the submitting WebSocket; finalized captions in the authenticated current room and participant transcripts | Cross-room broadcast, server-side caption persistence, late-join replay, or claims that mock output is validated SGSL |
| Aggregate operational measurements | Fixed-dimension counters and latency histograms, such as result codes and inference duration | Coordinates, tensors, serialized payloads, caption text, `meetingId`, `streamId`, or other unbounded/user-specific metric labels |

Raw media and derived values are separate classes, but both are sensitive. Calling landmarks "derived" or "normalized" does not make them safe to retain or observe.

## Allowed Processing Flow

1. The browser obtains camera frames for local preview. CSS mirroring is presentation only; the worker receives the unmirrored model source.
2. With recognition explicitly enabled, one frame at a time is transferred to the MediaPipe worker. The worker closes/releases each frame after processing; additional animation frames are skipped or delayed while it is busy.
3. The worker emits only normalized anatomical left-hand, right-hand, and upper-body pose features. Inadequately tracked frames are dropped. Accepted or valid idle frames are held only long enough to form a five-frame chunk.
4. The browser sends the strict v1 `landmark.chunk` on the current meeting WebSocket. Under socket pressure it retains only the newest unsent complete batch, so sensitive values cannot accumulate in an unbounded queue.
5. In the default segmented path, the browser resamples one completed gesture to 30 frames and sends six ordered five-frame chunks. The realtime service holds those chunks only in memory per connection and `streamId`, assembles one 30-frame candidate, permits one inference call in flight, and keeps only the newest pending complete candidate as a defensive bound. Five-frame-stride rolling evaluation exists only in explicit legacy compatibility mode.
6. The realtime service sends the selected window to `POST /api/v1/predictions` over the configured internal HTTP boundary. The live request has a 500 ms timeout and stale windows are not retried.
7. The inference service creates a transient `[1,30,224]` tensor for its singleton ONNX Runtime Java session. Its response returns `labelId`, nullable `captionText`, `confidence`, `modelVersion`, `inferenceLatencyMs`, and `mockModel`, never input values.
8. The realtime service keeps landmark state, tensors, predictions, recognition status, and unknown-sign feedback private to the submitting connection. After stabilization, it adds bounded source metadata and broadcasts only the finalized caption to authenticated participants in the same ephemeral room. Captions are not persisted or replayed to late joiners.

This is the complete authorized data path. Live recognition payloads are not an implied source of training data, test fixtures, analytics, support attachments, or product research.

## Separation From Training Capture

Camera permission, joining a room, starting a meeting session, and selecting **Start recognition** authorize only the transient live processing described above. None of those actions authorize collection, retention, labeling, dataset export, training, evaluation, or creation of a model artifact. A participant must be able to use live recognition without being asked to contribute training data.

Training capture must not tap, copy, replay, or redirect a live `landmark.chunk`, rolling window, inference tensor, prediction, caption, room event, credential, or live camera buffer. It runs only in the separately gated local development workflow defined by ADR-0003, with a reviewed vocabulary and its own versioned informed consent before the camera starts. Accepting or discarding each take and exporting accepted normalized landmarks are explicit actions in that workflow; silence, continued camera use, meeting participation, and prior live consent are never acceptance.

The training workflow does not weaken this document's zero-retention live boundary. It has no connection to the meeting, realtime, inference, analytics, or cloud services; raw media is never written; and its accepted local normalized-landmark exports follow ADR-0003's purpose, access, maximum 90-day retention, withdrawal, deletion, and repository-exclusion rules.

## Raw Media Rules

Raw video never leaves the browser. Code must not serialize, upload, retain, or observe any of the following outside the local capture/worker boundary:

- a `VideoFrame`, `ImageBitmap`, canvas pixel buffer, screenshot, encoded image, or video segment;
- raw pixels, byte arrays, blobs, object URLs, data URLs, or base64 representations;
- a raw-frame field embedded beside otherwise valid landmark metadata.

Browser frame objects must be closed or released after worker processing and during stop, camera replacement/disable, unmount, and error cleanup. Raw media must not enter WebSocket or HTTP payloads, browser/server logs, analytics events, local/session storage, IndexedDB, service-worker caches, crash reports, or test snapshots. Strict schemas use `additionalProperties: false` so image, video, blob, base64, byte, and accidental raw-frame fields are rejected rather than ignored.

## Landmark and Tensor Rules

Landmark and tensor values are transient sensitive derived data. This includes individual `x`, `y`, `z`, and `presence` values; 224-value feature arrays; five-frame chunks; rolling and pending windows; serialized inference request bodies; ONNX input buffers; embeddings; and any reversible or diagnostic representation of them.

They may exist only in bounded memory while the active recognition operation needs them. They are forbidden from:

- relational or document databases, Redis or other caches, object storage, local files, temporary files, queues, event streams, replay buffers, dead-letter records, backups, and browser storage;
- application, access, audit, debug, or `toString` logs, including partial arrays, sampled values, payload snippets, or serialized request/record objects;
- validation messages, exception messages, stack-trace annotations, HTTP error bodies, support diagnostics, and readiness/health details;
- OpenTelemetry span names, attributes, events, baggage, trace links, or captured request/response bodies;
- metric names, labels/tags, exemplars, or other dimensions, including `meetingId` and `streamId` as labels;
- analytics, session replay, crash-report attachments, profiling snapshots, heap/core dumps collected for routine diagnostics, or model-training/evaluation datasets.

No environment may enable request-body logging for `/api/v1/predictions` or payload logging for the recognition WebSocket. Redaction after ingestion is insufficient: these values must never be handed to the logging, tracing, metrics, or analytics system.

## Lifecycle and Deletion

The effective retention period for raw frames, landmarks, windows, and tensors is zero beyond the in-memory operation that requires them.

- Stop control, socket close, reconnect/new stream, invalid sequence discontinuity, configured tracking timeout, camera disable/replacement, component unmount, and worker or inference failure clear the applicable batches, windows, pending work, and stabilization state.
- A reconnect uses a new UUID `streamId`; data and results from the previous connection are ineligible for reuse or caption delivery.
- Replaced client batches and latest-wins server windows become unreachable immediately. Timed-out, superseded, and completed request buffers are released and are never retried or archived.
- Application shutdown releases in-memory stream state and closes the singleton ONNX session/environment. Shutdown does not serialize state for recovery.

Runtime garbage collection may determine the exact physical memory reclamation time. Code must nevertheless drop all references promptly and must not create a secondary retained copy.

## Errors and Observability

Validation and availability errors disclose only bounded structural metadata and reason codes, for example unsupported schema version, invalid feature count, invalid sequence, request too large, timeout, or model not ready. They must not echo a frame, coordinate, tensor value, request body, payload fragment, model path, or label map.

Permitted observability uses fixed, low-cardinality dimensions, such as event type, success/failure category, readiness state, and aggregate latency or queue-replacement counts. Request size and frame/window counts may be recorded as aggregate numeric measurements only when they cannot reproduce values; unique meeting/stream identifiers and caption text are not metric labels. Health/readiness may report whether the model is ready but not its filesystem path, tensor contents, or landmark data.

Inference timeout/unavailability and recovery are sent to the client as typed status events. A timeout never becomes a caption. Malformed inputs are rejected safely without including their contents in an exception or response.

## Connection-Local and Room-Shared Boundaries

Recognition state is scoped to one WebSocket connection and one `streamId`. Rate-limited `recognition.unknown` and typed recognition status/control events return only to that connection, and unknown events do not enter the transcript. A stabilized `caption.final` is source-attributed and broadcast only to authenticated participants in the same room. Caption persistence, cross-room delivery, and late-join replay remain prohibited.

Realtime tickets and short-lived resume tokens are private credentials. Resume tokens are single-use: a successful resume atomically rotates the credential, stores only its SHA-256 fingerprint in ephemeral room memory, and rejects replay of the consumed token. Credentials are accepted only during room join, never included in room snapshots or public events, and must not enter logs, traces, metrics, analytics, browser storage, or invitation links. Active-signer ownership authorizes a single participant to upload landmarks; denial and release do not disclose landmark or prediction data.

The room-shared final-caption envelope is limited to `schemaVersion`, `type`, `meetingId`, source `participantId`, stable `captionId`, `streamId`, non-negative room-public `sequence`, `payload`, and `occurredAt`. Its payload is limited to `labelId`, `text`, `confidence`, `modelVersion`, `inferenceLatencyMs`, `mockModel`, and the source participant's `sourceDisplayName`; it never contains a landmark, window, tensor, raw-frame field, or inference request body.

The deterministic synthetic model is identified with a mock-model marker in inference and caption metadata and visibly in the product. Neither its output nor the pending vocabulary may be described as linguistically approved SGSL recognition. The development simulator is available only when both the explicit client build flag and server development profile are enabled.

## Verification and Change Control

Automated checks must:

- consume the strict shared schemas and prove that extra raw-frame/image fields and malformed sensitive payloads are rejected;
- prove that outbound browser network payloads contain no raw frames or pixels;
- inject recognizable sentinel landmark/tensor values and prove those values are absent from captured frontend, realtime, inference, access, exception, trace, and metric output;
- exercise stop, reconnect, discontinuity, timeout, latest-wins replacement, and shutdown cleanup paths;
- prove that production/default simulator handling is disabled, connection-local recognition events stay private, finalized captions reach the current room exactly once, and neither credentials nor events cross into another room.

Any future proposal to retain, broadcast, analyze, replay, or train on raw media, landmarks, tensors, predictions, or captions changes this boundary. It requires a separate reviewed decision, explicit consent and usage terms where applicable, retention/deletion controls, access controls, and an updated privacy disclosure before implementation.

ADR-0003 supplies that separate decision only for its narrowly defined, informed-consent, local development capture workflow. It does not authorize retention or training from the live path, raw-media capture, remote collection, cloud storage, public dataset release, or broader reuse.
