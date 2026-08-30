# Milestone 3 completion and multilingual recognition execution plan

Status: Milestone 3 end-to-end ASL research slice implemented; broader physical-camera and production SgSL qualification remain open
Branch: `codex/milestone-3-live-sign-recognition`
Primary roadmap scope: Milestone 3 completion, with the smallest real-model Milestone 4 vertical slice needed to prove the workflow end to end

## 1. Outcome

Deliver a fast, local supported-sign workflow in which a signer can select an installed signed-language model pack, perform one supported isolated sign, see accurate progress on the camera stage, and receive exactly one model-backed caption.

```text
camera
  -> MediaPipe hand and upper-body landmarks
  -> tracking quality and session calibration
  -> gesture start/end segmentation
  -> language-pack feature adapter
  -> local Java ONNX Runtime inference
  -> confidence and unknown rejection
  -> recognized sign on the camera stage
  -> caption.final to the room
```

The implemented canary uses the official OpenHands ASL/WLASL SL-GCN checkpoint. A versioned browser feature layout supplies its exact graph points, and a self-contained ONNX wrapper preserves the Java runtime's public `[1,30,224]` boundary while bounding output to ten requested ASL concepts plus `NO_SIGN`. The evidence and immutable hashes are recorded in [`research/openhands-wlasl-checkpoint-audit.md`](research/openhands-wlasl-checkpoint-audit.md). It is an explicitly noncommercial ASL research pack; Python is used only to reproduce the export and is not a live runtime dependency.

This is supported-sign recognition, not universal sign-language translation. Every model pack must name its signed language, fixed vocabulary, source, licence, preprocessing contract, limitations, and qualification state. Sign language must be selected explicitly before recognition begins.

### 2026-08-30 implementation decision

The completed checkpoint, SgSL-source, and repository-seam audits found no pretrained artifact eligible for production SgSL use. They did identify a bounded local ASL research route. In particular:

- the live Java runtime remains a single startup-selected model with an exact `float32 [1,30,224] -> [1,N]` boundary and explicit metadata;
- OpenHands SL-GCN is closed-set and language-specific, so the adapter keeps it ASL-only, adds the required pose points through `mediapipe-holistic-224-v2`, and blocks production promotion;
- SignBart is the closest landmark/size fit, but has no stated code/weight licence, reliable display-label contract, ONNX/Java evidence, or trained unknown class;
- the strongest SgSL-labelled sequence lead is the NUS CS3244 14-label LSTM, but it has no licence, released dataset/consent terms, held-out-signer evidence, or non-signing class and requires 30 by 1,662 Holistic features; and
- no candidate is one model for “all sign languages.” Language packs remain separate because their vocabularies and linguistic targets are separate.

Accordingly, Steps 2 through 7 now provide a working single-pack ASL research slice without adding a second camera, transport, or Python serving path. The browser-to-Java path was validated with an official Hello clip through a virtual webcam. The broader pack selector and Steps 8 through 10 remain gated work, and the existing singleton runtime/configuration seam remains authoritative until a production model passes rights, label, preprocessing, rejection, parity, latency, and language-review gates.

## 2. Non-negotiable boundaries

- Keep raw camera frames inside transient browser processing.
- Transmit only the versioned landmark representation required by the selected pack.
- Keep tracking details, model tensors, and intermediate probabilities private to the signer.
- Broadcast only a stable `caption.final` result.
- Never relabel ASL, Turkish Sign Language, or another language as SgSL.
- Never silently fall back from a real model to the synthetic fixture.
- Preserve an explicit `mockModel` or equivalent provenance field.
- Preserve `NO_SIGN`/unknown rejection; unsupported movement must not be forced to the nearest known label.
- Keep camera, recognition consent, and active-signer ownership controls intact.
- Reuse `DESIGN.md` and `frontend/styles/system.css` for any interface change.

## 3. Regressions that must be closed

The implementation is not complete until each prior failure is reproducible as an automated test and then passes on a physical camera.

| ID | Observed failure | Required behavior |
|---|---|---|
| R1 | A visible hand still leaves the interface at “Waiting for hands” or generic “show a hand gesture.” | Show the tracked-hand count immediately. If the frame is unusable, show the precise reason: missing shoulders, low confidence, frame edge, lighting, or calibration. |
| R2 | The interface remains at “Gesture in progress.” | Every gesture reaches a bounded terminal path: candidate dispatched, explicit cancellation/retry, or actionable failure. A wall-clock watchdog must recover even when camera cadence is irregular. |
| R3 | A gesture is captured but no model result appears. | Latch `Processing` when the candidate is dispatched, correlate it with a gesture/request identifier, then settle on recognized, not-recognized, service failure, or timeout. |
| R4 | “Processing” or an in-flight gesture never clears. | A terminal-event watchdog releases the one-in-flight latch and returns to a safe retryable state without publishing a caption. |
| R5 | Tracking works but the bundled model cannot identify the performed sign. | Load a genuine sign-language-trained checkpoint with its original language and label map. The synthetic model remains test-only. |
| R6 | A held sign repeats or a second sign is ignored indefinitely. | Emit at most once per gesture, require release/re-arm, and allow a genuine repetition after returning to idle. |
| R7 | An unsupported gesture becomes a confident caption. | Reject it as unknown/`NO_SIGN`, show private feedback, publish no `caption.final`, and return to ready. |

## 4. Stage-level observability

Add a privacy-safe recognition trace that records state transitions and counters, never coordinates, frames, screenshots, or raw model input. It must identify where a run stopped:

1. Camera frame available.
2. MediaPipe hand count and shoulder-anchor availability.
3. Tracking-quality state and calibration progress.
4. Gesture phase, elapsed duration, motion band, and accepted-frame count.
5. Gesture candidate created and assigned a gesture/request ID.
6. Six landmark chunks sent and accepted.
7. Thirty-frame window assembled.
8. Selected model pack ready.
9. Inference started and completed, failed, or timed out.
10. Rejection/stabilization decision.
11. Private result or public `caption.final` emitted.

The production UI should expose only useful user-facing summaries. Detailed counters may live in development diagnostics and tests.

## 5. Execution loop

For every step below, the implementing agent must use this loop:

```text
reproduce failure
  -> add a failing unit/contract/E2E test
  -> implement the smallest fix
  -> run focused tests
  -> run the full affected service suite
  -> run physical-camera/browser evidence when required
  -> record evidence and remaining risks
```

Do not mark a checkbox complete from code inspection alone. If a gate fails, classify it as tracking, segmentation, transport, model compatibility, inference, state mapping, performance, or product feedback; add a regression fixture; fix; and rerun.

## 6. Ordered implementation steps

### Step 1 — Freeze the prediction and model-pack contracts

Dependencies: none

- Define a versioned `ModelPackManifest` containing pack ID, signed language, vocabulary version, model version, qualification state, source/checkpoint digest, licence, input/output names and shapes, preprocessing version, labels, thresholds, and CPU/runtime requirements.
- Define qualification states such as `mock`, `research`, and `qualified`.
- Pin the selected pack for the lifetime of a recognition stream; a language/model change starts a new stream.
- Validate model output dimension against its label map at startup.
- Fail closed if the selected real pack is absent, incompatible, corrupt, or unready.

Acceptance:

- Invalid manifests and model/label mismatches fail startup tests.
- The known synthetic artifact cannot be relabelled as real.
- Captions and private outcomes identify the exact model version and provenance.

### Step 2 — Reproduce and instrument the stuck-state failures

Dependencies: Step 1 contract skeleton only

- Add deterministic fixtures for R1 through R4, including visible hand with missing shoulders, low-confidence handedness, dynamic motion that never settles, irregular frame cadence, temporary occlusion, candidate dispatch without terminal response, stale terminal response, and service timeout.
- Add gesture/request correlation without logging landmark values.
- Add the privacy-safe stage trace described above.
- Preserve current one-hand, two-hand, mirrored-preview, frame-edge, held-sign, and return-to-idle fixtures.

Acceptance:

- Tests prove the old bad outcomes and locate the stalled stage.
- No raw media or landmark values appear in logs, traces, snapshots, or error payloads.

### Step 3 — Make the camera and segmentation state machine bounded

Dependencies: Step 2 tests

- Keep hand tracking status independent from model classification status.
- Replace generic hand prompts with the actual canonical quality reason.
- Add a maximum gesture wall-clock duration in addition to the existing frame-count limit.
- Latch `Processing` as soon as a completed candidate is accepted for transport. New local motion must not mask an in-flight inference as “Gesture in progress.”
- Add terminal-response and candidate-transport watchdogs that clear the one-in-flight latch on timeout, reconnect, stop, ownership loss, camera loss, and inference failure.
- Reset cleanly after prolonged tracking loss while preserving the existing short occlusion grace.
- Keep stationary-sign capture, pre-roll, hysteresis, resampling, missing masks, release/re-arm, and duplicate suppression.

Acceptance:

- R1 through R4 pass in unit and browser tests.
- No valid run can remain indefinitely in starting, active, ending, processing, or in-flight state.
- A timeout never creates `caption.final` and always leaves a clear retry action.

### Step 4 — Validate the first existing checkpoint outside the product

Dependencies: Step 1

- Obtain the OpenHands ASL/WLASL candidates and metadata from the first-party release.
- Record immutable source URL, digest, exact checkpoint configuration, vocabulary, preprocessing, dataset terms, and research-only status where applicable.
- Run the original reference implementation on licensed reference fixtures.
- Inspect exact keypoints, coordinate system, handedness, mirroring, missing values, sequence length, normalization, and output semantics.
- Export to ONNX with fixed, documented input/output contracts.
- Compare reference-framework and ONNX probabilities and decisions under a declared numerical tolerance.
- Compare released candidates, export the strongest compatible lightweight graph candidate, and benchmark it through the local Java CPU path.

Acceptance:

- The original checkpoint produces expected reference outputs.
- ONNX parity passes for all reference fixtures.
- Model source, digest, language, vocabulary, licence status, and known limitations are documented.
- No product code changes are justified by guessed preprocessing.

**Audit outcome (2026-08-30): RESEARCH GO / PRODUCTION STOP.** SL-GCN was the strongest official release candidate inspected. It is exported behind a pinned, hash-verified adapter that maps `mediapipe-holistic-224-v2` to the exact 27-point graph and binds only the ten requested ASL concepts. Unsupported logits compete through a frozen rejection margin, idle hands resolve to `NO_SIGN`, and metadata blocks production promotion. WLASL rights and ASL language scope still prohibit any SgSL or production claim. See [`research/openhands-wlasl-checkpoint-audit.md`](research/openhands-wlasl-checkpoint-audit.md).

### Step 5 — Implement the versioned landmark adapter and transport

Dependencies: Steps 3 and 4

- Reuse the existing MediaPipe hand and pose extraction.
- Implement an explicit adapter from browser MediaPipe results to the checkpoint’s exact feature schema.
- If the pack requires landmarks unavailable in `[30,224]`, introduce a strict versioned schema rather than silently padding or repurposing fields.
- Keep gesture boundaries from Milestone 3 and resample the completed interval to the pack’s declared temporal input.
- Update browser, WebSocket, realtime window, prediction request, and inference validation contracts together.
- Reject mixed schema, mixed pack, partial gesture, invalid mask, non-finite, out-of-order, or stale input.

Acceptance:

- Browser, transport, Java, and reference preprocessing produce equivalent tensors from the same fixture.
- Existing v1 synthetic tests remain available as explicit fixture coverage.
- Raw frames still never cross the browser boundary.

### Step 6 — Load and serve the pack with Java ONNX Runtime

Dependencies: Step 5

- Load the selected manifest, labels, thresholds, and ONNX artifact in `backend/sign-inference-service`.
- Return label probabilities, selected label, confidence, model version, pack ID, signed language, mock/research status, and inference latency through strict internal contracts.
- Calibrate confidence and top-label margin using known supported fixtures plus idle, transitions, incomplete signs, and unrelated motion.
- Map low confidence, invalid output, `NO_SIGN`, and rejection to private not-recognized feedback only.
- Do not add Python to the runtime path.

Acceptance:

- Python/ONNX/Java parity passes.
- Corrupt, slow, missing, or mismatched artifacts fail closed.
- Unknown inputs cannot become public captions.

### Step 7 — Connect the real result to the room and camera experience

Dependencies: Step 6

- Add an explicit signed-language/model-pack selector before recognition starts.
- Show tracked-hand count independently from recognition.
- Show `Gesture in progress`, then latched `Processing`, then the recognized sign and confidence on the camera stage.
- Keep confirmed captions in the transcript and temporary guidance near the camera.
- Clearly label research and mock packs; never imply SGSL support from an ASL pack.
- Use existing design tokens, shared button variants, live-region rules, 4:3 contained video, stable controls, keyboard support, and reduced-motion behavior.

Acceptance:

- A supported sign displays its label and confidence and produces exactly one `caption.final` for both participants.
- An unknown sign displays private not-recognized guidance and publishes no caption.
- Interface state is understandable without color and does not duplicate screen-reader announcements.

### Step 8 — Complete the Milestone 3 physical-camera matrix

Dependencies: Steps 3 and 7

Validate at minimum:

- One visible hand plus both shoulders.
- Left- and right-handed signing.
- One-hand and two-hand signs.
- Stationary and dynamic signs.
- Near/far camera distance.
- Faster and slower performance.
- Mirrored preview.
- Temporary hand occlusion.
- Hand near every frame edge.
- Low light and low tracking confidence.
- Camera/body movement without a sign.
- Dropped and irregular frames.
- Held sign, release, and genuine repeated sign.
- Recognition service unavailable and delayed.

Acceptance:

- The two previously observed stuck states do not recur.
- Every failure gives an actionable reason and recovers without restarting the meeting.
- The broader signer/device acceptance items in the roadmap are closed with recorded, privacy-safe evidence.

### Step 9 — Add compatible language packs one at a time

Dependencies: first pack passes Steps 4 through 8

- Reuse the pack registry and runtime for compatible OpenHands checkpoints for Argentine, Chinese, Greek, Indian, and Turkish sign languages.
- Run source, licence, preprocessing, parity, unknown-rejection, latency, and physical-flow gates independently for every pack.
- Do not merge label maps or automatically infer signed language from a single isolated gesture.
- Treat SignVerse-2M as a future non-commercial pretraining/research source, not a drop-in recognizer.
- Keep SgSL as a separate pack requiring linguistically reviewed labels, approved rights, signer-independent evidence, and genuine SgSL data.

Acceptance:

- Installing or removing one pack cannot change another pack’s output mapping.
- The selected language and limitations are visible before recognition begins.
- A pack without complete evidence cannot be marked `qualified`.

### Step 10 — Performance, quantization, cleanup, and release gate

Dependencies: Steps 1 through 9 for the packs being released

- Measure MediaPipe cadence, segmentation completion, transport, preprocessing, ONNX p50/p95, end-to-end post-boundary latency, CPU, memory, and artifact size.
- Target ONNX p95 below 100 ms on the development computer and remain within the existing 500 ms inference timeout.
- Try dynamic INT8 quantization for the LSTM only after FP32 parity and quality pass. Retain FP32 if quantization causes a material regression.
- Keep the synthetic model only in explicit test/development configuration.
- Remove dead model paths and duplicated adapters only after their replacements are covered.
- Run all frontend, backend, ML, contract, privacy, E2E, Chrome, Edge, and release-verifier checks.
- Update roadmap status only from recorded evidence.

Acceptance:

- Full repository verification passes.
- Physical-camera supported, unknown, repeated, timeout, and unavailable flows pass.
- The released real pack loads without a mock fallback.
- Rollback consists of selecting the last known-good pack artifact/configuration, not retraining.

## 7. Milestone 3 requirement coverage

| Roadmap requirement | Plan coverage |
|---|---|
| Canonical camera-quality states | Steps 2, 3, 7, and 8 |
| Optional hand/upper-body overlay and signing guide | Step 7, validated in Step 8 |
| Session calibration | Steps 2, 3, and 8 |
| Hand/wrist/finger and pose-aware activity | Steps 2 and 3 |
| Start/end hysteresis and bounded segmentation | Step 3 |
| Thirty-frame resampling or versioned replacement | Steps 4 and 5 |
| Missing-landmark masks and handedness | Steps 2, 5, and 8 |
| Held-sign duplicate suppression and re-arm | Steps 2, 3, and 8 |
| Actionable unknown feedback | Steps 3, 6, 7, and 8 |
| Physical positioning and camera/body compensation | Step 8 |
| Privacy boundary | Every step; explicitly gated in Steps 2 and 5 |

## 8. Final release checklist

- [x] A genuine sign-language-trained local model is active for the bounded ASL research lane.
- [x] The selected signed language and vocabulary are explicit.
- [x] A visible hand never produces a misleading generic waiting message in the automated state matrix.
- [x] Gesture progress is bounded and cannot remain stuck.
- [x] Candidate dispatch visibly becomes `Processing`.
- [ ] A supported physical-camera sign produces the correct on-camera label.
- [x] Exactly one `caption.final` reaches both current room participants in automated room tests.
- [x] Unknown, idle, incomplete, and unrelated movement produce no caption in automated rejection tests.
- [x] Held signs do not repeat; a released and repeated sign is recognized again in segmentation tests.
- [x] Python, ONNX, Java, label-map, and feature-adapter parity pass for the ASL research pack.
- [x] Model and dataset sources, digests, licences, and limitations are recorded.
- [ ] ONNX p95 and end-to-end latency meet the declared budget.
- [ ] Chrome and Edge physical-camera checks pass.
- [x] No raw camera media or landmark coordinates are persisted or logged.
- [x] Mock mode remains explicit and cannot silently replace a real pack.
- [ ] Milestone 3 roadmap acceptance items have evidence, not only checked code.

## 9. Stop conditions

Stop promotion, while preserving completed engineering work, if any of the following is true:

- The checkpoint or dataset rights do not permit the intended use.
- Exact preprocessing or label order cannot be established.
- Reference-to-ONNX-to-Java parity cannot be reproduced.
- The model cannot reject idle or unrelated motion safely enough for captions.
- Physical-camera behavior fails the supported-sign or stuck-state gates.
- The latency budget cannot be met on CPU without unacceptable quality loss.

Do not work around a failed gate by renaming the language, weakening provenance, hiding model readiness, broadcasting an unconfirmed guess, or collecting live meeting data for training.
