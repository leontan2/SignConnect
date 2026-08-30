# Sign recognition pipeline

This document describes the live recognition path implemented in SignConnect today. It is the
contract that Milestones 3 and 4 must preserve unless a versioned replacement is introduced.

> **Model status:** the browser performs real MediaPipe landmark extraction, but the bundled
> server-side ONNX artifact is a deterministic integration fixture. It detects a synthetic
> hand-presence pattern and makes **no SGSL recognition claim**. The local UI deliberately labels
> its output as mock output (`frontend/apps/meeting/src/MeetingApp.tsx:1337-1342`).

## End-to-end flow

```text
camera MediaStream
  -> <video> element
  -> ImageBitmap (at most 25 per second, one in flight)
  -> MediaPipe worker
       -> browser-only overlay and canned-gesture feedback
       -> normalized [224] feature frame
       -> browser quality/calibration gates and gesture segmenter
       -> one resampled [30][224] candidate per completed gesture
  -> six ordered [5][224] landmark.chunk WebSocket messages
  -> signer-authorized, connection-private realtime session
  -> one non-overlapping [30][224] window (SEGMENTED_GESTURES default)
  -> POST /api/v1/predictions
  -> Java float32 tensor [1][30][224]
  -> ONNX probabilities [1][label_count]
  -> completed-gesture decision
       -> private recognition.status / recognition.unknown
       -> room-broadcast caption.final
```

Camera frames and the local overlay stop at the browser boundary. Only the normalized landmark
features in a completed gesture candidate cross that boundary. Only a finalized caption crosses
from the signer's private recognition path into the shared room event stream.

## 1. Browser capture and MediaPipe output

`LandmarkCaptureController` samples the live `<video>` with `createImageBitmap`. Capture is capped
at 25 FPS (40 ms between attempted captures), permits only one worker request in flight, and uses a
monotonic `performance` timestamp. Recognition capture starts paused and resumes only after signer
ownership is granted and the `recognition.control/start` message has been sent
(`frontend/apps/meeting/src/recognition/LandmarkCaptureController.ts:259-318`,
`frontend/apps/meeting/src/recognition/LandmarkCaptureController.ts:328-393`, and
`frontend/apps/meeting/src/recognition/useSignRecognition.ts:209-327`). The worker closes each
transferred `ImageBitmap` after processing (`frontend/apps/meeting/src/recognition/landmark.worker.ts:337-418`).

The worker runs these MediaPipe Tasks in `VIDEO` mode:

- `GestureRecognizer`, when its model loads, with two hands and 0.5 detection, presence, and
  tracking thresholds; otherwise `HandLandmarker` with the same thresholds.
- `PoseLandmarker` with one pose, 0.5 detection, presence, and tracking thresholds, and no
  segmentation mask.

The setup is in `frontend/apps/meeting/src/recognition/landmark.worker.ts:88-147`. The worker consumes
MediaPipe's image landmark arrays (`landmarks`), not world-landmark or pixel arrays. It takes the
first detected pose and up to two classified hands
(`frontend/apps/meeting/src/recognition/landmark.worker.ts:158-180`).

MediaPipe's handedness result is swapped before feature placement: this application sends an
unmirrored capture to MediaPipe, while the classifier labels handedness as if its input were
mirrored. A MediaPipe `Left` classification therefore becomes the signer's anatomical `Right`, and
vice versa (`frontend/apps/meeting/src/recognition/landmark.worker.ts:149-155`). If a detected hand has no usable handedness
classification, the whole frame is rejected as low quality rather than put into the wrong feature
slot.

### Browser-only canned gesture path

When `GestureRecognizer` is available, the worker also selects the highest-scoring allowlisted
canned gesture at confidence 0.6 or above. The allowlist is `Closed_Fist`, `Open_Palm`,
`Pointing_Up`, `Thumb_Down`, `Thumb_Up`, `Victory`, and `ILoveYou`; the result becomes stable after
four consecutive frames with the same label (`frontend/apps/meeting/src/recognition/contracts.ts:10-20`
and `frontend/apps/meeting/src/recognition/landmark.worker.ts:228-250,296-315`).

This path is presentation-only. Its label is never used as an ONNX label and never becomes a
caption. The browser-local snapshot contains overlay x/y coordinates, confidence, handedness, and
the canned-gesture result; it travels only from the worker to React
(`frontend/apps/meeting/src/recognition/contracts.ts:63-147`).

## 2. The 224-feature frame contract

Every accepted frame has 56 fixed landmark slots and four values per slot:

```text
[normalized_x, normalized_y, normalized_z, presence]
```

The exact layout is defined in `frontend/apps/meeting/src/recognition/contracts.ts:3-26`:

| Inclusive feature indices | Landmark slots | Base index for slot `i` |
| --- | --- | --- |
| `0..83` | Anatomical left hand, MediaPipe hand landmarks `0..20` | `4 * i` |
| `84..167` | Anatomical right hand, MediaPipe hand landmarks `0..20` | `84 + 4 * i` |
| `168..223` | Pose landmarks `11..24`, in that order | `168 + 4 * i` |

Within every slot, offsets `+0`, `+1`, and `+2` are x/y/z; offset `+3` is the binary presence mask.
The pose selection is upper-body landmarks 11 through 24 inclusive: shoulders, elbows, wrists,
hand-related pose points, and hips. All downstream validators require exactly 224 finite values and
require every presence value to be exactly `0` or `1`
(`backend/realtime-service/src/main/java/com/signconnect/realtime/api/LandmarkChunkEvent.java:67-93`
and `backend/sign-inference-service/src/main/java/com/signconnect/inference/api/PredictionRequest.java:86-120`).

### Centering and scale normalization

For pose landmarks 11 (left shoulder) and 12 (right shoulder), let:

```text
center = (left_shoulder + right_shoulder) / 2       # x, y, and z
scale  = hypot(right.x - left.x, right.y - left.y)  # two-dimensional shoulder width

x' = (x - center.x) / scale
y' = (y - center.y) / scale
z' = (z - center.z) / scale
```

The same shoulder center and 2D shoulder-width scale normalize both hands and the selected pose
points. Each normalized coordinate is rounded to eight decimal places and negative zero is
canonicalized to zero (`frontend/apps/meeting/src/recognition/normalizeLandmarks.ts:59-88,122-140`).
There is no additional per-hand centering, velocity feature, rotation normalization, or temporal
normalization in the current browser pipeline.

### Quality gates and missing landmarks

The default quality thresholds are defined at
`frontend/apps/meeting/src/recognition/normalizeLandmarks.ts:24-34`:

- both shoulder anchors must be present at confidence/visibility 0.5 or above;
- 2D shoulder width must be between 0.02 and 2.0;
- at least 8 of the 14 selected pose points must be present;
- a selected hand must have handedness confidence 0.5 or above and at least 8 of its 21 points;
- every raw x/y/z coordinate must be finite and have absolute value at most 4;
- every normalized coordinate must be finite and have absolute value at most 20.

For pose, a point is missing when it is absent, has `presence === 0`, or has a supplied `visibility`
below 0.5. For hands, point visibility is intentionally ignored; absence or `presence === 0` marks
it missing. An individual missing point always occupies its original slot as `[0,0,0,0]`, so later
indices never shift. A hand that was not detected, or whose best handedness classification is below
0.5, zero-fills all 21 slots on that anatomical side. If hands were detected but neither classified
side passes the hand threshold, or a selected hand has fewer than 8 present points, the frame is
rejected rather than treated as idle
(`frontend/apps/meeting/src/recognition/normalizeLandmarks.ts:50-57,91-95,141-176`).

The full-frame rejection reasons are:

- `INADEQUATE_ANCHORS`: missing/weak shoulders or shoulder width outside the accepted range;
- `LOW_QUALITY`: insufficient pose/hand evidence or unusable handedness;
- `NON_FINITE`: a coordinate or score is not finite;
- `OUTLIER`: an input or normalized coordinate exceeds its bound.

Rejected frames are not retained for a candidate. An accepted frame is `active` if at least one hand
point is present after these gates; otherwise it is `idle`
(`frontend/apps/meeting/src/recognition/normalizeLandmarks.ts:178-198`). This distinction drives the
local `tracking` versus `no-hands` UI state. The default server path receives only completed gesture
candidates, not the intervening idle stream.

### Browser-local quality, calibration, and segmentation

Alongside normalization, the worker derives a browser-local tracking state with this strict
precedence: `no-person`, `upper-body-missing`, `left-hand-missing`, `right-hand-missing`,
`out-of-frame`, `low-quality`, then `ready`. It checks pose points 11 through 16, requires 17 of 21
finite points for a visible hand, uses an 8% frame-edge margin, and distinguishes minimum tracking
confidence 0.5 from strong tracking confidence 0.65
(`frontend/apps/meeting/src/recognition/trackingQuality.ts:13-137`). These facts are presentation
metadata; they do not add fields to a v1 landmark frame.

A session-local calibrator reaches `ready` after eight consecutive quality-ready frames whose
shoulder scale stays within 15% of its running baseline. A bad frame resets an incomplete
calibration (`frontend/apps/meeting/src/recognition/trackingQuality.ts:140-201`). Calibration state
is not stored or transmitted.

The browser-local gesture segmenter measures comparable hand points in both screen space and a
shoulder-centred, shoulder-scaled, shoulder-rotation-normalized pose space. Its motion signal uses
the conservative lower screen/pose displacement for common motion, while separately retaining
finger-within-hand, between-hand, and pose-wrist-relative motion. This compensates for common
camera/body translation, rotation, and scale changes without cancelling a real one-hand or
two-hand gesture moving against the torso. Three frames at normalized motion 0.08 or above start a
gesture; four frames at 0.025 or below end it. A frame gap
over 200 ms, lost quality, or insufficient comparable points resets the segment. It retains at most
90 accepted source frames and resamples a completed segment to exactly `[30][224]`: coordinates are
linearly interpolated only when both endpoint masks are present, otherwise the nearest whole
landmark slot supplies coordinates and its binary mask
(`frontend/apps/meeting/src/recognition/trackingQuality.ts:204-447`).

The worker emits each completed, timestamped candidate exactly once
(`frontend/apps/meeting/src/recognition/landmark.worker.ts:368-406`).
`LandmarkCaptureController` and `useLandmarkCapture` forward it once to `useSignRecognition`, which
is the authoritative transport consumer. Because frozen v1 terminal events identify a stream but
not an individual gesture, that consumer permits exactly one completed gesture to remain in flight
for a stream. It ignores later completed candidates until the matching final/unknown/failure settles
the current gesture
(`frontend/apps/meeting/src/recognition/LandmarkCaptureController.ts:414-421`,
`frontend/apps/meeting/src/recognition/useLandmarkCapture.ts:13-20,42-59`, and
`frontend/apps/meeting/src/recognition/useSignRecognition.ts:147-183`). The live path no longer
transmits a continuous stream of accepted active or idle frames.

## 3. Batching, windows, and timing

### Browser to realtime service

`useSignRecognition` accepts only a completed candidate containing exactly 30 timestamped frames of
224 finite features. It assigns stream-global frame and chunk sequences, then splits the candidate
into exactly six schema-v1 `landmark.chunk` messages. Each message is JSON `[5][224]` plus stream,
sequence, and per-frame timestamp metadata
(`frontend/apps/meeting/src/recognition/useSignRecognition.ts:60-104`). Chunk and frame sequences
start at zero for a fresh stream and continue across later completed gestures in that stream.

Capture begins paused. Candidate transport becomes eligible only after active-signer ownership is
granted and the sequence-zero `recognition.control/start` send succeeds. The six chunks for one
candidate are then sent consecutively. A compliant browser does not dispatch another candidate on
that stream until the current result settles. If the socket is under pressure, a candidate is invalid, or
any send fails, the browser fails closed by stopping recognition; it does not retain, replace, or
send only part of a newer candidate. Stop, reconnect, signer replacement, and camera-off lifecycle
paths clear the current transport state (`frontend/apps/meeting/src/recognition/useSignRecognition.ts:133-183,209-353`).

The timing is gesture-driven rather than a fixed 200 ms chunk cadence. Capture is attempted at up to
25 FPS; the start and end hysteresis require three high-motion and four low-motion observations,
respectively, and a segment retains at most 90 source frames. At completion, those source timestamps
are evenly resampled across exactly 30 frames and all six wire chunks can be sent in one burst. The
candidate timestamps preserve the observed gesture span; they do not imply that transport waits
1.2 seconds after segmentation (`frontend/apps/meeting/src/recognition/trackingQuality.ts:204-222,286-319,328-447`).

The realtime service accepts landmark/control traffic only from the current room member holding
the active-signer grant for the exact stream (`backend/realtime-service/src/main/java/com/signconnect/realtime/web/CaptionWebSocketHandler.java:152-212,351-354`). It enforces contiguous chunk
and frame sequences and increasing timestamps. A sequence gap or a wall-clock gap longer than two
seconds resets the window/decision pipeline. When a received chunk itself exposes the gap, that
chunk establishes the new sequence baseline and is not used for inference
(`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:284-338`).

### Realtime service to inference service

The default `SEGMENTED_GESTURES` input mode gives the 30-frame window an effective stride of 30.
Consequently, the six chunks from one browser candidate assemble one non-overlapping `[30][224]`
window and create one inference opportunity; the next completed gesture assembles a distinct
window. The browser's one-in-flight rule normally serializes these opportunities. As a defensive
server rule for legacy or non-browser clients, at most one request is in flight and a newer complete
candidate may replace an older pending candidate before evaluation without mixing frames. The default is declared in
application configuration, and `effectiveStrideFrames()` prevents
the configured legacy stride of 5 from creating overlapping windows in this mode
(`backend/realtime-service/src/main/resources/application.yml:21-32`,
`backend/realtime-service/src/main/java/com/signconnect/realtime/config/RecognitionProperties.java:36-65,141-150,217-220`,
and `backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:122-132`). Therefore:

- wire chunk shape: `[5][224]` JSON numbers;
- completed browser candidate: `[30][224]`, carried as six uninterrupted chunks;
- default server candidate: one `[30][224]` Java `List<Double>` per completed gesture; compliant browsers serialize gestures, while the server retains latest-pending replacement as a defensive fallback;
- inference opportunity: immediately after the sixth chunk of that gesture is accepted;
- no inference windows are produced from incomplete gestures or continuous idle capture.

`ROLLING` remains an explicit compatibility input mode. In that mode only, the same window utility
uses stride 5: its first trailing window is produced after 30 frames and another can be produced after
each subsequent 5 frames. `recentHandPresent` is then computed from the 42 hand-presence slots in the
newest five-frame stride (`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RollingLandmarkWindow.java:23-87`).
The current browser does not emit that legacy continuous rolling input.

For either mode, the realtime service sends a schema-v1 request to `POST /api/v1/predictions` with a
new request UUID, the stream/window identity, and those 30 frames. Its configured response timeout is 500 ms
(`backend/realtime-service/src/main/java/com/signconnect/realtime/inference/InferenceClient.java:32-56`
and `backend/realtime-service/src/main/java/com/signconnect/realtime/config/RecognitionProperties.java:29-70`).

Only one HTTP inference is in flight per recognition connection. If more windows become ready, only
the newest pending window is retained. Extremely rapid completed gestures can therefore supersede
an older pending candidate under load
(`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:378-428`).

### Java to ONNX

The inference API validates exactly 30 ordered frames of exactly 224 finite JSON numbers. It flattens
them in frame-major, feature-major order to 6,720 Java `float` values, then creates an ONNX float32
tensor of shape `[1,30,224]` (`backend/sign-inference-service/src/main/java/com/signconnect/inference/api/PredictionRequest.java:22-79` and
`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/OnnxModelRuntime.java:42,238-250`).

At startup the runtime rejects a model unless its configured input is float32 `[1,30,224]` and its
output is float32 `[1,label_count]`. At prediction time it also requires each output value to be
finite and within `[0,1]`, then selects the highest-probability label
(`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/OnnxModelRuntime.java:361-407`). The response returns label ID, caption text, confidence, model
version, inference latency, and the mandatory `mockModel` provenance flag.

The selected label also has an internal typed outcome. Because the frozen v1 response has no
outcome discriminator, `NO_SIGN`, `REJECT`, and a `SIGN` below the metadata decision threshold all
fail closed to `labelId=NO_SIGN, captionText=null`. Consequently, no non-recognized internal outcome
can become a final caption even if a downstream confidence setting is less strict. An unavailable runtime returns
no prediction candidate (`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/CanonicalModelDecision.java:9-55` and
`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/OnnxModelRuntime.java:258-276`).

## 4. Current ONNX artifact and provenance

The default application configuration leaves model resources and expected version blank and denies
mock models, so model readiness is unavailable unless a complete model selection is explicitly
configured. Only the `local` Spring profile selects the bundled artifacts, pins `synthetic-v1`, and
sets the explicit mock-model allow flag:

- `backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1.onnx`
- `backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1-labels.json`

See `backend/sign-inference-service/src/main/resources/application.yml:21-27` and
`backend/sign-inference-service/src/main/resources/application-local.yml:1-14`. At runtime, a mock
artifact is still accepted only when the allow flag is combined with a `local`, `development`, or
`test` Spring profile. Initialization verifies the expected model version, configured tensor names,
declared artifact filename, model bytes against the metadata SHA-256, installed ONNX Runtime minimum
version, and that the known bundled synthetic hash cannot be relabeled as a real model
(`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/OnnxModelRuntime.java:147-202`).

The artifact is code-generated, contains no trained weights, recordings, landmarks, or third-party
dataset content, and is explicitly marked `modelVersion: synthetic-v1` and `mockModel: true`. Its
metadata pins the artifact hash, input/output names and shapes, float32 type, feature-layout and
normalization versions, feature order, and a 0.8 decision threshold. Its two typed outcomes are
`NO_SIGN` and `MOCK_ACTIVE`; the latter is a `SIGN` outcome mapped to the caption “Synthetic active
gesture”
(`backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1-labels.json:14-49`).
The same authoritative metadata document also carries architecture, training-data provenance,
evaluation, ONNX parity, runtime, SGSL review, governance, and production-promotion evidence. The
bundled fixture is explicitly `BLOCKED` because it is synthetic, lacks SGSL-fluent Deaf review, and
lacks signer-independent evaluation
(`backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1-labels.json:50-116`).

The ML exporter emits this full shared metadata shape, and the Java runtime consumes and strictly
validates that same shape rather than relying on a second deployment-only label file. Validation
includes unknown-field rejection, tensor/feature identity, ordered label outcomes, provenance,
parity/runtime bounds, review/governance fields, and fail-closed promotion rules
(`backend/sign-inference-service/src/main/java/com/signconnect/inference/model/ModelContract.java:23-153,277-510`).

The transparent generator is preserved in
`backend/sign-inference-service/src/main/resources/models/README.md:43-90`. It was generated with
`onnx==1.22.0`, opset 17, and IR version 8. It flattens `[1,30,224]`, applies fixed linear weights only
to all 42 hand-presence positions in every frame, adds a fixed bias, and applies Softmax to produce
`[1,2]`. It does not inspect coordinates, pose, motion, sign boundaries, or linguistic context.
The documented artifact SHA-256 is
`fd2cf50b2bdbe8c7c6953e0f809b33df2012de2a476b09fcff0e6987e289c4a8`.

This model is useful for proving transport, tensor construction, lifecycle, and caption publication.
It is not evidence of sign-language accuracy or generalization.

The separate `ml/sign-recognition` package is an offline training/evaluation/export lane, not a
second live recognizer. It provides TCN and GRU candidates and exports a fixed `features`
float32 `[1,30,224]` input through Softmax to `probabilities [1,N]`, then writes the same full
metadata contract consumed by Java
(`ml/sign-recognition/src/signconnect_ml/exporting.py:37-74,125-166`). Model selection uses the
validation split; the locked test split is evaluated once and produces confusion-matrix-derived
per-class, no-sign, reject/OOV, and thresholded-decision metrics. That evidence is bound to the
checkpoint's exact canonical tensor state by `modelStateSha256`, and export rejects legacy or
swapped-weight evidence. The exported ONNX bytes are separately bound to deployment metadata by
`artifactSha256` (`ml/sign-recognition/src/signconnect_ml/training.py:308-359,662-690`). Its bundled
generated data is explicitly non-production synthetic data; the repository still contains no
trained SGSL model or real participant dataset (`ml/sign-recognition/README.md:1-26`). An exported
candidate becomes live only when its artifact and metadata are deliberately selected through the
inference-service model configuration and all runtime gates accept them.

## 5. Prediction stabilization and observable states

In the default `SEGMENTED_GESTURES` mode, the browser has already established the temporal gesture
boundary. Each assembled 30-frame candidate is therefore an independent occurrence and its single
inference result is evaluated immediately:

- a non-`NO_SIGN` label with a non-null caption and confidence at or above 0.80 produces `Final`;
- `NO_SIGN`, a null caption, or confidence below 0.80 produces private `Unknown(LOW_CONFIDENCE)`.

There are no rolling votes, idle-finalization frames, label cooldown, or unknown-event rate limit in
this mode. The session accepts only a strictly increasing completed-window sequence for the active
stream, so a replayed or out-of-order candidate cannot duplicate a caption. A genuinely newer
completed gesture can still repeat the same recognized label as a separate occurrence
(`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RecognitionStabilizer.java:64-78` and
`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:430-488`).

The explicit `ROLLING` compatibility mode retains the earlier temporal stabilizer. With current
settings, three consecutive high-confidence evaluations of the same non-`NO_SIGN` label arm a
candidate, and two subsequent `NO_SIGN` evaluations without hands in the newest five-frame stride
finalize it. Repeated low-confidence or unstable evaluations can produce a private unknown event;
unknowns are rate-limited to one every 2 seconds, and the same finalized label is suppressed for
1.5 seconds (`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RecognitionStabilizer.java:48-62,94-197,235-242`).

The server maps lifecycle and outcomes to these wire events:

| Event | Meaning | Visibility |
| --- | --- | --- |
| `recognition.status` `READY/STARTED` | Valid sequence-0 start control established the private stream | Signer connection only |
| `recognition.status` `INVALID_INPUT/*` | Invalid event, unsupported version, ordering gap, or continuity reset | Signer connection only |
| `recognition.status` `UNAVAILABLE/TIMEOUT` or `SERVICE_UNAVAILABLE` | HTTP inference failed or timed out; pipeline state was reset | Signer connection only |
| `recognition.status` `READY/RECOVERED` | A later inference succeeded after unavailability | Signer connection only |
| `recognition.unknown` | Immediate low-confidence/`NO_SIGN` completed gesture in segmented mode; repeated low-confidence or unstable predictions in rolling mode | Signer connection only |
| `recognition.status` `STOPPED/STOPPED_BY_CLIENT` | Valid stop control ended and reset the stream | Signer connection only |
| `caption.final` | One completed gesture produced a known, captioned, high-confidence label; rolling compatibility still uses arm-then-idle finalization | Broadcast to current room members |

Start/stop and ordering behavior is implemented in
`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:221-338`; prediction-to-event mapping is at
`backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java:430-505`. Before broadcast, the room registry rechecks that the
caption source still owns the active signer stream and deduplicates the caption
(`backend/realtime-service/src/main/java/com/signconnect/realtime/room/InMemoryRoomRegistry.java:229-256`).

In the browser, accepted active/idle frames appear as `tracking`/`no-hands`, while normalization
rejection appears as `low-quality`. Worker/model failures become `unavailable` or `error`; the user
text mapping is in `frontend/apps/meeting/src/recognition/useSignRecognition.ts:106-130`. Server
unknown reasons become “not enough confidence” or “tracking was unstable,” and inference timeout,
unavailability, recovery, and stop states receive distinct messages
(`frontend/apps/meeting/src/MeetingApp.tsx:93-132`).

Camera guidance uses the fixed 13-value `CANONICAL_APPLICATION_STATES` mapping. Its source precedence
is camera off; camera initializing/recognition disabled/no frame; non-ready tracking quality;
incomplete calibration; gesture in progress; completed gesture processing; recognized or
not-recognized server outcome; then ready to sign
(`frontend/apps/meeting/src/recognition/CanonicalStateMapper.ts:6-61`). Dispatching a completed
candidate clears the previous outcome and establishes the pending “Processing” state; the next
`caption.final` or `recognition.unknown` selects “Sign recognized” or “Sign not recognized”
(`frontend/apps/meeting/src/MeetingApp.tsx:87-125,181-227,580`). Changes are also announced through
the accessibility live region (`frontend/apps/meeting/src/MeetingApp.tsx:1015-1022,1385-1388,1428-1431`).
These presentation states are browser-local and are not fields in the realtime protocol.

## 6. Privacy and data-lifetime boundary

| Data | Where it exists | Crosses network? | Shared with room? | Persisted by this pipeline? |
| --- | --- | --- | --- | --- |
| Camera pixels / `ImageBitmap` | `<video>` and MediaPipe worker | No | No | No |
| Raw MediaPipe landmarks | MediaPipe worker only | No | No | No |
| Local overlay projection, quality/calibration/phase, and canned gesture | Worker and transient React snapshot | No | No | No |
| Normalized feature frames and incomplete gesture segments | MediaPipe worker and browser segmenter | No | No | No |
| Completed `[30][224]` gesture candidate | Worker/controller/hooks; then six signer-private chunks, one realtime window, and one inference request | Yes, only after completion and signer authorization | No | No |
| Recognition status / unknown result | Signer's WebSocket connection | Yes | No | No |
| Final caption and prediction metadata | Realtime room event stream | Yes | Yes | No durable storage in the current in-memory room pipeline |

The user-facing consent copy states the actual boundary: starting recognition consents to transient
hand/body landmark transmission, while raw video is not transmitted
(`frontend/apps/meeting/src/MeetingApp.tsx:1425-1427`). The worker's local overlay deliberately excludes
depth and is not added to landmark chunks (`frontend/apps/meeting/src/recognition/contracts.ts:63-66`).
Java request, frame, window, model-contract, and response `toString` methods redact landmark/payload
contents; inference logs record lifecycle/provenance rather than feature arrays. The runtime holds
frames only in bounded in-memory candidates/windows/requests. Continuous idle or rolling feature
capture is not transmitted by the current browser, and the room registry broadcasts only the final
caption after active-signer authorization.

This is a routing and minimization boundary, not an assertion that derived landmarks are anonymous.
Normalized landmarks can still describe a person's movement and must remain protected in transit,
in service access controls, observability, diagnostics, and any future persistence work.

## 7. Compatibility invariants for Milestones 3 and 4

A trained model can replace the synthetic fixture without changing the live transport only if it
honors all of these current invariants:

1. Input is float32 `[1,30,224]` using the exact landmark order, normalization, and missing-point
   mask above.
2. Output is float32 `[1,label_count]`, aligned position-for-position with a validated label map.
3. The label map pins the matching artifact SHA-256 and feature contract, includes exactly one
   typed `NO_SIGN` with no caption, includes a typed sign outcome, and truthfully sets
   `modelVersion` and `mockModel`.
4. Training/export applies the same handedness correction, shoulder normalization, point-quality
   rules, browser gesture-boundary and resampling semantics, 25 FPS capture target, and 30-frame
   candidate—or introduces a new versioned feature contract across browser, realtime, inference,
   fixtures, and model together.
5. Evaluation and data splits must demonstrate signer-independent performance; the bundled
   synthetic fixture cannot be used as accuracy evidence.
6. Raw video remains browser-local, landmark traffic remains signer-authorized/private, and only
   finalized captions enter the room broadcast stream.
7. The current v1 browser transport carries each completed candidate as exactly six ordered
   five-frame chunks. Default server mode is `SEGMENTED_GESTURES` with effective stride 30;
   overlapping stride-5 evaluation is available only through explicit `ROLLING` compatibility mode.
