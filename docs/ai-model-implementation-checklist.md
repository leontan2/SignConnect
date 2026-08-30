# AI/Model Implementation Loop Checklist

This file is the executable completion ledger for SignConnect Milestones 3 and 4. It does not replace the product roadmap. Work the gates in order, attach evidence, and repeat the first failing gate until it passes or an external blocker is recorded.

## Completion truth

Use these labels consistently:

- **Synthetic integration proof**: the deterministic mock model traverses the real transport, windowing, Java ONNX Runtime, decision, and caption path. This is useful regression evidence, but it is not sign-language recognition.
- **Milestone 3 complete**: real MediaPipe measurements drive camera guidance and gesture segmentation; bounded gestures normalize into the existing model window; and the accessible lifecycle is accepted with a physical camera on a supported browser. No real-model claim is implied.
- **Pipeline-proof model**: a model trained on a small, consented sign-language dataset proves training, export, and serving mechanics. Fewer than five signers or incomplete independent review keeps this below genuine Milestone 4 completion.
- **Milestone 4 complete**: a local model genuinely trained on reviewed SGSL data passes the held-out-signer, rejection, parity, Java, privacy, latency, and browser gates in this file with `mockModel: false`.

Checking a box means evidence exists. Code presence, a green synthetic fixture, an ONNX file that merely loads, or a model trained on another sign language does not satisfy Milestone 4.

## Loop protocol

For every work loop:

1. [x] Select the first phase whose gate is not passed.
2. [x] Record the branch, commit, date, operator, and starting failure below.
3. [x] Implement the smallest change that can close that failure without creating a second camera, recognition, or realtime path.
4. [x] Run the phase commands and record exit codes plus durable evidence paths.
5. [x] Review architecture, privacy, accessibility, and real-versus-mock truthfulness.
6. [x] If any check fails, leave the phase open, record the failure and next experiment, then repeat.
7. [x] If progress requires external data, approval, or expertise, update the blocker register; continue only the unblocked phases.
8. [x] Mark a phase passed only when every required item and its pass gate are satisfied.

### Current loop record

| Field | Value |
| --- | --- |
| Date/time | 2026-08-30; implementation and required verifier loop complete |
| Branch | `codex/gesture-segmentation` |
| Starting commit | `7ec095d` (latest committed verification baseline before this resumed loop) |
| Ending implementation commit | `94af8899178d38d3843482ebe30caec607ebb227` (`94af889`) |
| Operator | Codex parallel-agent loop |
| Phase/gate | Resumed G3-G8 implementation and evidence; G5 and genuine G9 blocked |
| Starting failure | Camera quality and gesture boundaries were not canonicalized end to end; the server still treated every five-frame chunk as a rolling stride; no authorized SGSL dataset or promoted genuine model existed. |
| Change summary | Corrected the live readiness gate to require shoulders plus at least one signing hand, zero-filled absent optional landmarks while preserving `[1,30,224]`, added a stationary-sign hold path with bounded pre-roll and camera-gap grace, and bounded continuous/noisy gestures to one inference candidate at 90 source frames. Removed the browser's canned generic-gesture classifier, corrected the SGSL language tag to `sls`, and added governed vocabulary binding, consent/capture/review/retention schemas, lifecycle and duplicate audits, clean source provenance, reproducible training, robustness slices, exact-digest staged-data guards, repository-trusted evidence anchors, evidence-bound promotion/release, cross-runtime parity, Java benchmarks, and safe ML CLI entry points. All bundled model evidence remains explicitly synthetic. |
| Commands and exit codes | Unified release verifier: exit `0`; backend Maven suites: `3 + 4 + 63 + 113 = 183` passed; meeting Vitest: `113` passed; ML pytest: `225` passed inside the verifier and `228` passed after the final trust-root review; training-contract fixtures: `23` passed; staged-file guard: `20` focused tests and the real `87`-file staged scan passed; typecheck and both production builds passed; browser latency: 20 measured samples after one warm-up, p50 `25.1 ms`, p95 `46.1 ms`, minimum `18.8 ms`, maximum `46.5 ms`; bundled Chromium, Chrome, and Edge E2E: `16/16` each; development simulator gate: `1/1`; release-runner self-test: PASS; `git diff --check`: exit `0`. |
| Evidence paths | `docs/architecture/sign-recognition-pipeline.md`; `docs/research/sign-language-model-candidates.md`; `contracts/sign-recognition/v1/`; `contracts/sign-recognition-training/v1/`; `frontend/apps/meeting/src/recognition/`; `backend/realtime-service/src/test/java/com/signconnect/realtime/SegmentedGestureRecognitionSessionTest.java`; `backend/sign-inference-service/src/test/java/com/signconnect/inference/`; `ml/sign-recognition/tests/` |
| Remaining failure or blocker | The live one-hand/shoulder gate and camera presentation were exercised on Windows, but broader physical-device/signer acceptance remains open. Genuine Milestone 4 remains blocked by approved consent/governance, an SGSL-fluent Deaf reviewer, licensed multi-signer SGSL recordings, and locked independent test signers. |
| Next loop action | Use `docs/research/sgsl-external-input-request.md` to obtain reviewer, consent, licence, and dataset evidence; then reopen G5 and run genuine signer-disjoint TCN/GRU training plus the fail-closed production promotion gates. |

## Non-negotiable invariants

Recheck these in every phase that touches the recognition path.

- [x] Browser MediaPipe remains the only camera/landmark extraction path.
- [x] CSS mirroring remains presentation-only; the model source and anatomical left/right slots remain unmirrored.
- [x] Raw camera frames, pixels, screenshots, audio, and encoded media never enter WebSocket, HTTP, logs, analytics, storage, or training implicitly.
- [x] Live recognition landmarks and tensors remain transient sensitive data and are not reused as training data.
- [x] The five-frame v1 `landmark.chunk`, `[1,30,224]` contract, WebSocket path, and Java inference boundary remain authoritative. In default `SEGMENTED_GESTURES` mode, the browser sends six ordered five-frame chunks for one completed gesture and serializes the next dispatch until the stream-only v1 result settles. Realtime assembles one 30-frame candidate and retains one-in-flight/latest-pending replacement as a defensive rule for legacy or non-browser clients. `ROLLING` is an explicit legacy compatibility mode only.
- [x] There is no second camera pipeline, recognition pipeline, room path, or cloud AI dependency.
- [x] MediaPipe/camera quality determines tracking guidance; the neural model classifies bounded signs.
- [x] One authoritative mapper produces exactly the 13 canonical application states.
- [x] Intermediate tracking facts, tensors, probabilities, recognition status, and unknown feedback remain private to the submitting signer.
- [x] Only stable `caption.final` events are shared with the authenticated current room.
- [x] `NO_SIGN`, unknown, rejected, incomplete, and low-confidence gestures never create `caption.final`.
- [x] Mock and real modes remain explicit end to end; a missing or invalid real model fails readiness and never silently falls back to mock.
- [x] Product language says **supported-sign recognition**, not full translation or continuous sign-language translation.
- [x] Any changed wire contract is versioned or explicitly proven backward compatible with strict fixtures.

## Gate ledger

| Gate | Status | Evidence path or report | Reviewed by/date |
| --- | --- | --- | --- |
| G0 Baseline and prerequisite | PASS | Milestone 2 `d062c83`; baseline evidence below | Codex / 2026-08-30 |
| G1 Live pipeline and 224-feature audit | PASS | `docs/architecture/sign-recognition-pipeline.md` | Codex / 2026-08-30 |
| G2 Model/dataset/licence decision | PASS | `docs/research/sign-language-model-candidates.md`; no external asset downloaded | Codex / 2026-08-30 |
| G3 Compatibility and canonical contracts | PASS | `contracts/sign-recognition/v1/`; `contracts/sign-recognition-training/v1/`; canonical mapper/runtime tests | Codex / 2026-08-30 |
| G4 Milestone 3 tracking and segmentation | PARTIAL | Engineering and fixture gates pass; a Windows physical-camera check confirmed the corrected one-hand/shoulder path, while broader device/signer acceptance remains open. This is not a genuine-model claim | Broader physical-camera acceptance required |
| G5 Training-data authorization and dataset | BLOCKED | ADR-0003 defines the prerequisite boundary; `docs/research/sgsl-external-input-request.md` defines the evidence request; consent, reviewer, and real data are absent | Recheck only on new external evidence |
| G6 Genuine model training, evaluation, and ONNX | PARTIAL | Reproducible training, vocabulary binding, robustness, release, promotion, and synthetic parity tooling pass; genuine SGSL run absent | Codex / 2026-08-30 |
| G7 Java real-model integration | PARTIAL | Java contract/load/fail-closed, cross-runtime parity, and benchmark-report tooling pass with the synthetic artifact; no promoted real artifact | Codex / 2026-08-30 |
| G8 Browser, privacy, accessibility, and performance | PARTIAL | Synthetic browser gate `16/16` in all three browsers, 20-sample latency, and a bounded Windows physical-camera check pass; genuine-model journeys and promoted-artifact performance remain open | Codex / 2026-08-30 |
| G9 Final genuine-SGSL promotion | BLOCKED | Open G5 data/reviewer blockers and incomplete G6-G8 genuine evidence | Recheck only after G5 clears |

## G0 — Baseline and prerequisite

### Required work

- [x] Milestone 2 is committed and its acceptance evidence is linked.
- [x] The working branch is the approved Milestone 3 or Milestone 4 branch.
- [x] JDK 21, Node/npm, browsers, Python, and `uv` versions are recorded.
- [x] The existing synthetic model remains visibly and structurally identified as mock.
- [x] Baseline and current-loop failures are captured separately before their dependent gates are marked passed.

### Commands

```powershell
git status --short --branch
java -version
node --version
npm --version
python --version
uv --version
.\scripts\verify.ps1
npm run test:e2e
git diff --check
```

On the managed Windows host, use the known short temporary path for Java NIO tests when required:

```powershell
$env:TEMP = 'C:\jtmp'
$env:TMP = 'C:\jtmp'
.\scripts\verify.ps1
```

### Evidence

| Field | Value |
| --- | --- |
| Baseline commit | Milestone 2 starting baseline: `d062c83912f3acf2aa3502c8201812218e24286b` (`d062c83`) |
| Tool versions | Temurin JDK `21.0.12`; Node `v24.19.0`; npm `11.17.0`; Python `3.10.1`; uv `0.8.17`; Playwright `1.62.1`; bundled Chromium `151.0.7922.34` (revision `1234`) |
| Repository verifier result | **PASS:** backend `162` (`3 + 4 + 63 + 92`), meeting `97`, ML `42`, training-contract fixtures `23`, typecheck, both production builds, and the release-runner self-test passed. |
| Chromium E2E result | **PASS:** all `16/16` bundled-Chromium journeys passed after the canonical-result and deterministic fixture lifecycle fixes. |
| Known pre-existing failures | No accepted Milestone 2 or Milestone 3 regression remains. Genuine SGSL data/reviewer inputs were absent at baseline and remain an external Milestone 4 blocker. |

**Gate pass:** baseline verifier and bundled-Chromium acceptance pass from a cleanly owned runner, or every unrelated pre-existing failure is documented and accepted before proceeding.

**On failure:** fix the prerequisite first. Do not diagnose new model behavior on an unstable transport or room baseline.

## G1 — Live pipeline and 224-feature audit

### Required deliverables

- [x] A code-location map identifies MediaPipe loading, worker processing, normalization, `landmark.chunk`, segmented and legacy rolling windows, inference requests, ONNX execution, stabilization, `caption.final`, and frontend state presentation.
- [x] The feature map confirms or corrects the current expected grouping: indices `0–83` anatomical left hand, `84–167` anatomical right hand, and `168–223` pose landmarks `11–24`, each point ordered `x,y,z,presence`.
- [x] Coordinate origin, shoulder-width scaling, missing-point encoding, pose-anchor rejection, valid idle frames, handedness correction, preview mirroring, temporal order, and absence/presence of velocity features are documented from code and fixtures.
- [x] Window ownership is explicit: the browser resamples one completed gesture to 30 frames, sends six ordered five-frame v1 chunks, and waits for its stream-only result before another dispatch; default realtime `SEGMENTED_GESTURES` assembles one non-overlapping candidate and creates one inference opportunity, with latest-pending replacement retained defensively for other clients. Five-frame-stride overlapping evaluation exists only in explicit legacy `ROLLING` mode.
- [x] Current timeout, confidence, stabilization, idle, cooldown, and unknown-rate thresholds are recorded with configuration locations.
- [x] Current model input/output names, ranks, shapes, label-map loading, mock metadata, readiness behavior, and latency fields are recorded.

### Audit command

```powershell
rg -n "224|30|landmark\.chunk|caption\.final|OnnxModelRuntime|RecognitionStabilizer|MediaPipe|HandLandmarker|PoseLandmarker" frontend backend contracts config
```

### Evidence

| Field | Value |
| --- | --- |
| Audit document/path | `docs/architecture/sign-recognition-pipeline.md` |
| Feature-map source lines | `frontend/apps/meeting/src/recognition/contracts.ts`; `frontend/apps/meeting/src/recognition/normalizeLandmarks.ts`; reconstruction table in the architecture document |
| Tensor/window source lines | `frontend/apps/meeting/src/recognition/workerProtocol.ts`; `LandmarkCaptureController.ts`; `backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RealtimeRecognitionSession.java`; `RecognitionProperties.java` |
| Normalization/handedness source lines | `frontend/apps/meeting/src/recognition/normalizeLandmarks.ts`; `landmark.worker.ts`; `normalizeLandmarks.test.ts`; `LandmarkCaptureController.test.ts` |
| Runtime/stabilizer source lines | `backend/sign-inference-service/src/main/java/com/signconnect/inference/model/OnnxModelRuntime.java`; `backend/realtime-service/src/main/java/com/signconnect/realtime/recognition/RecognitionStabilizer.java` |
| Reviewer/date | Codex evidence review / 2026-08-30 |

**Gate pass:** a reviewer can reconstruct every one of the 224 values and follow one accepted camera frame to either a private rejection or a room-shared final caption without assumptions.

**On failure:** add missing tests or documentation before selecting a model. Model compatibility cannot be inferred from shape alone.

## G2 — Model, dataset, and licence decision

### Candidate review

- [x] Research includes isolated sign recognition, landmark/skeleton temporal models, TCN, GRU, recurrent/LSTM references, lightweight graph models, WLASL/ASL references, AUTSL, SignVerse, and SGSL-specific sources. The small TCN plus GRU comparison was selected over expanding the first implementation to a BiLSTM.
- [x] Every candidate records language, dataset/vocabulary scope, input representation, architecture or absence of one, weights/model availability, licence and commercial constraints, signer-independent evidence, ONNX/CPU suitability, and available latency/quality evidence.
- [x] Direct primary-source URLs and the 2026-08-30 access date are retained. No dataset, checkpoint, or model was downloaded, so there is no imported artifact revision/hash/licence file to archive in this loop.
- [x] ASL, Turkish Sign Language, or another sign language is labelled only as an engineering reference; it is never substituted for SGSL.
- [x] Unlicensed weights, non-commercial restrictions incompatible with the intended use, unverifiable provenance, and random-split-only claims are rejected with reasons.
- [x] The chosen path is one of: legally usable compatible pretrained weights, or a repository-owned TCN training path with a GRU comparison.
- [x] Any input mismatch has an explicit adapter decision; no silent change to `[1,30,224]` is accepted.

### Evidence

| Field | Value |
| --- | --- |
| Candidate matrix | `docs/research/sign-language-model-candidates.md` |
| Source/licence archive | Twenty-four direct primary-source URLs with access date in the candidate matrix; no external data/model artifact downloaded |
| Selected architecture | Repository-owned small TCN first, small GRU comparison on the identical future signer-disjoint split; current execution is synthetic tooling proof only |
| Rejected candidates/reasons | SgSL Sign Bank/NTU references lack deployable training rights/artifacts; WLASL/ASL/AUTSL use the wrong language and/or restricted rights; SignVerse is continuous, automatically supervised, non-commercial, and shape-incompatible; reviewed SgSL prototypes lack the required word task, compatible representation, provenance/consent, reviewer, signer-disjoint, or deployable-artifact evidence |
| Adapter decision | No live adapter: preserve `[1,30,224]` and train to the exact contract; external feature formats are research references only |
| Decision reviewer/date | Codex evidence review / 2026-08-30; genuine label/vocabulary approval still requires an SGSL-fluent Deaf reviewer |

**Gate pass:** the selected model path is technically compatible, legally supportable, local/CPU/ONNX-capable, explicit about target language, and backed by primary evidence.

**On failure:** select the custom TCN-plus-GRU training path, keep public models as references only, and activate the external-data blocker. Do not download or ship questionable weights to make the gate appear complete.

## G3 — Compatibility and canonical contracts

### Required contracts and tests

- [x] One canonical mapper returns only: `Camera off`, `Camera initializing`, `No person detected`, `Upper body not fully visible`, `Left hand missing`, `Right hand missing`, `Hands too close to the frame edge`, `Lighting or tracking quality too poor`, `Ready to sign`, `Gesture in progress`, `Processing`, `Sign recognized`, or `Sign not recognized`.
- [x] Deterministic priority and collision fixtures cover every canonical state.
- [x] Tracking confidence and model confidence are separate fields with separate semantics.
- [x] Model unavailable/readiness is a status/error condition, not a false `Sign not recognized` result.
- [x] The internal model result reuses existing repository types where possible and includes label id, nullable caption, confidence, model version, latency, and `mockModel` without a duplicate competing representation.
- [x] The versioned vocabulary maps model index to label id and caption outside Java source.
- [x] Startup rejects label-count, input-shape, output-shape, input/output-name, model-version, metadata, and checksum mismatches.
- [x] The gesture interval is cropped/resampled/padded to exactly 30 frames while preserving missing-landmark presence values.
- [x] No adapter is required for the selected repository-owned training path; the source and target contract is `[1,30,224]` throughout.
- [x] Contract fixtures prove extra raw media fields and malformed/non-finite arrays are rejected.
- [x] No canonical-state expansion changes the public room contract; only finalized captions remain room-shared.

### Commands

```powershell
.\scripts\verify.ps1
npm run test:e2e:list
git diff --check
```

### Evidence

| Field | Value |
| --- | --- |
| Contract/schema paths | `contracts/sign-recognition/v1/`; `contracts/sign-recognition-training/v1/` |
| Canonical-state fixture report | `frontend/apps/meeting/src/recognition/CanonicalStateMapper.test.ts`; meeting suite `97` passed, including Processing-to-result collision coverage |
| Vocabulary/metadata path | `contracts/sign-recognition-training/v1/model-metadata.schema.json`; `backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1-labels.json` (explicit synthetic fixture) |
| Adapter spec/tests or “not required” | Not required: browser, training, ONNX, and Java retain `[1,30,224]`; strict fixtures validate the common contract |
| Verifier exit code | Unified release verifier exit `0`: backend `183`, meeting `113`, ML `225`, training contracts `23`, typecheck, production builds, runner self-test, bundled Chromium `16/16`, installed Chrome `16/16`, installed Edge `16/16`, simulator `1/1`, and performance `1/1`; final post-review ML `228` and staged guard `20/20` plus the real `87`-file scan passed |

**Gate pass:** frontend, realtime, inference, and ML code consume one compatible contract, all canonical collisions are deterministic, and strict fixtures pass.

**On failure:** resolve the contract at the boundary. Do not add translation glue independently in multiple services.

## G4 — Milestone 3 tracking and gesture segmentation

### Camera-quality state machine

- [x] Real MediaPipe facts drive person/torso visibility, left/right hand presence, edge proximity, and tracking/lighting-quality guidance.
- [x] Thresholds and hysteresis are configurable and covered by boundary tests.
- [x] Camera initialization/off states come from the camera lifecycle, not the classifier.
- [x] Session calibration requires eight quality-ready frames with both shoulders, at least one signing hand, and stable shoulder scale; a vocabulary-specific mode may require both hands. Calibration data remains in memory for the active session only. Anatomical slots remain unmirrored and preview mirroring remains presentation-only.
- [x] The optional overlay uses existing design-system tokens and can be disabled without disabling recognition.
- [x] The overlay and text guidance expose no unsupported accuracy claim and remain keyboard/screen-reader usable.

### Gesture state machine

- [x] Activity uses average 2D motion across comparable hand landmarks, normalized by shoulder scale and elapsed time, with visible-point, tracking-quality, timestamp, and dropped-gap gates.
- [x] Sustained activity is required to leave idle/ready.
- [x] Start and end hysteresis prevent camera adjustment and single-frame jitter from becoming gestures.
- [x] Temporary occlusion has a bounded policy and cannot merge unrelated gestures indefinitely.
- [x] Gesture end dispatches at most one inference window.
- [x] A stationary supported-sign pose dispatches once after a bounded hold, while pre-roll and brief quality/camera-cadence gaps do not discard the candidate.
- [x] A held sign cannot repeatedly dispatch or caption.
- [x] Return to idle permits a genuine repeated sign after the cooldown.
- [x] Fast/slow gestures resample consistently to 30 frames.
- [x] Fixtures cover left/right handedness, mirrored preview, one/two hands, occlusion, camera distance, speed, dropped gaps, held signs, and repeated signs.

### Commands

```powershell
npm test --workspace @signconnect/meeting
npm run typecheck
npm run build
.\scripts\verify.ps1
npm run verify:release
```

### Evidence

| Field | Value |
| --- | --- |
| Quality-state unit report | `frontend/apps/meeting/src/recognition/trackingQuality.test.ts`, `CanonicalStateMapper.test.ts`, and MediaPipe-derived facts in `LandmarkCaptureController.test.ts`; included in `113` passing meeting tests |
| Segmentation/resampling unit report | `frontend/apps/meeting/src/recognition/LandmarkCaptureController.test.ts`; `backend/realtime-service/src/test/java/com/signconnect/realtime/SegmentedGestureRecognitionSessionTest.java`; exactly six five-frame chunks assemble one 30-frame candidate and one inference |
| Recorded/synthetic fixture inventory | `frontend/apps/meeting/src/recognition/e2eFixtureCapture.ts` and `.test.ts`; `contractFixtures.test.ts`; synthetic browser fixture only, not SGSL accuracy evidence |
| Accessibility review | `frontend/apps/meeting/src/MeetingApp.test.tsx`; `tests/e2e/sign-recognition-accessibility.spec.ts`; the full `16/16` Chromium gate passed with live-region, overlay state, 320-pixel completed-state reflow, reduced-motion, focus, contrast, and axe coverage |
| Running-browser screenshots/trace | Bundled Chromium `16/16` passed. A privacy-preserving Windows physical-camera check confirmed the contained 4:3 preview, one-hand tracking, and corrected readiness guidance without retaining a screenshot or landmark values. Neither fixture nor physical-camera evidence is genuine SGSL model evidence; see `docs/validation/sign-recognition-browser-matrix.md`. |

**Engineering gate:** MediaPipe-derived facts produce actionable canonical guidance; stationary signs and dynamic gestures each produce one bounded candidate; adjustment fixtures do not start a gesture; held signs do not repeat; continuous/noisy motion does not remain stuck; deliberate movement or release separates repetitions; and all Milestone 3 fixtures plus the repository verifier pass. **Full Milestone 3 acceptance additionally requires broader supported-device and signer acceptance beyond the bounded Windows check.**

**On failure:** tune only against versioned fixtures and record threshold changes. Never train the classifier to hide a deterministic tracking-state defect.

## G5 — Training-data authorization and dataset

This gate is separate from live recognition. The current privacy boundary prohibits treating live landmarks or tensors as training data.

### Authorization before capture

- [ ] A separate reviewed decision authorizes training-data collection and identifies permitted purpose.
- [ ] Consent wording is explicit and separate from live-recognition consent.
- [ ] Retention duration, deletion SLA, access roles, export policy, withdrawal process, and downstream model invalidation are approved.
- [ ] SGSL reviewer role, availability, and approval method are recorded.
- [ ] Five candidate intents are approved for linguistic correctness, isolated-sign suitability, non-manual requirements, and visual separability before labelled capture.
- [ ] Capture is development-only, local/offline, excluded from default/production builds, and cannot connect to meeting, realtime, or inference services.
- [x] Raw recordings and private landmarks stay outside Git; ignore rules and staged-file scanning reject private capture/training artifacts. This repository-control evidence does not authorize collection.

### Dataset gate

- [ ] A versioned manifest includes sample id, pseudonymous signer id, SGSL label/gloss, handedness, capture conditions, timestamp/provenance, sequence reference, consent/usage record, and split assignment.
- [ ] The dataset contains five reviewed SGSL signs plus `NO_SIGN`, idle, transitions, unknown/negative gestures, incomplete gestures, and natural movement.
- [ ] It covers multiple speeds, distances, backgrounds, lighting conditions, and applicable handedness.
- [ ] At least five consented signers exist for a genuine Milestone 4 gate; three to four signers may prove mechanics only.
- [ ] Train, validation, and locked test partitions are disjoint by signer and immutable for a run.
- [ ] Duplicate/near-duplicate and signer leakage checks pass.
- [ ] Dataset checksum, version, class counts, signer counts, and exclusions are recorded without committing private data.

### Required ML command interface

The implementation may refine module names, but equivalent checked-in commands must exist and this file must be updated in the same change.

```powershell
uv sync --project ml/sign-recognition --extra test --frozen
uv run --project ml/sign-recognition pytest ml/sign-recognition/tests/test_manifest_and_splits.py ml/sign-recognition/tests/test_shared_contract_fixtures.py
node contracts/sign-recognition-training/v1/validate-fixtures.mjs
```

### Evidence

| Field | Value |
| --- | --- |
| Approved collection/privacy decision | `docs/adr/0003-training-data-capture-boundary.md` is accepted as a prerequisite boundary, but capture remains disabled until its consent/reviewer gates pass; this is not collection approval |
| Consent/usage terms version | **BLOCKED:** no approved participant-facing version |
| SGSL reviewer and approval | **BLOCKED:** no engaged SGSL-fluent Deaf reviewer or dated label approval |
| Dataset manifest version/hash | Schema/tooling only: `contracts/sign-recognition-training/v1/dataset-manifest.schema.json`; no real manifest/hash |
| Signer/class/split summary | Synthetic mechanical fixture only; no consented SGSL signers or classes |
| Leakage/duplicate report | Signer-overlap fixture is rejected by the 23-fixture contract validator and ML split tests; no genuine dataset report exists |

**Gate pass:** authorized, licensed, consented, reviewer-approved SGSL data with five or more signer-disjoint identities and adequate negative coverage is available to the reproducible training CLI.

**On failure:** record the blocker and stop real capture/training. Synthetic fixtures may continue to validate code paths but cannot clear this gate.

## G6 — Genuine model training, evaluation, and ONNX

### Reproducibility

- [x] Dependencies and supported Python range are locked in `ml/sign-recognition/uv.lock` and `pyproject.toml`.
- [ ] Config records seed, architecture, input contract, augmentation, optimizer, schedule, thresholds, dataset hash, split hash, and code commit.
- [ ] A small TCN is trained first and a small GRU is evaluated on the identical split; another architecture requires recorded evidence.
- [ ] Model selection uses validation data only; the locked signer-independent test set is evaluated once for the promotion candidate.
- [ ] Vocabulary contains five reviewed SGSL labels plus `NO_SIGN`; model output dimension equals the versioned label map.
- [ ] Calibration/rejection thresholds are derived from validation data, not the final test set.
- [ ] Checkpoint, ONNX artifact, label map, metadata, evaluation report, and model card have hashes.

### Quality and parity

- [ ] Evaluation reports accuracy, macro F1, per-class precision/recall/F1, confusion matrix, `NO_SIGN` false-positive rate, unknown/rejection rate, and signer-independent results.
- [ ] Held-out-signer macro F1 is at least `0.80`.
- [ ] False-final rate on `NO_SIGN` and unknown samples is no more than `5%`.
- [ ] Robustness slices cover speed, distance, lighting, handedness, occlusion, incomplete gestures, held signs, and repeats.
- [x] Python and ONNX probabilities agree on frozen **synthetic** fixtures within absolute tolerance `1e-5` and relative tolerance `1e-4`; genuine SGSL parity remains open.
- [x] Python and ONNX produce identical label/rejection decisions on the current **synthetic** parity fixture; genuine SGSL parity remains open.
- [x] The synthetic exported ONNX is self-contained, removes a stale external-data sidecar, uses the tested runtime path, and emits checksum/provenance metadata; this does not promote it.

### Required ML command interface

```powershell
uv run --project ml/sign-recognition pytest
uv run --project ml/sign-recognition signconnect-ml generate-synthetic --output ml/sign-recognition/fixtures/NON_PRODUCTION_SYNTHETIC/generated
uv run --project ml/sign-recognition signconnect-ml train --config ml/sign-recognition/configs/tcn-v1.toml
uv run --project ml/sign-recognition signconnect-ml train --config ml/sign-recognition/configs/gru-v1.toml
uv run --project ml/sign-recognition signconnect-ml evaluate --checkpoint "$env:SIGNCONNECT_CHECKPOINT" --manifest "$env:SIGNCONNECT_DATASET_MANIFEST" --split-file "$env:SIGNCONNECT_SPLIT" --output "$env:SIGNCONNECT_EVALUATION"
uv run --project ml/sign-recognition signconnect-ml export --checkpoint "$env:SIGNCONNECT_CHECKPOINT" --manifest "$env:SIGNCONNECT_DATASET_MANIFEST" --output "$env:SIGNCONNECT_ONNX" --verify-parity
```

### Evidence

| Field | Value |
| --- | --- |
| Dataset/split/code/config hashes | Synthetic manifest/split/checkpoint hashes are exercised by `ml/sign-recognition/tests/test_training_and_export.py`; genuine dataset/split/code hashes remain blocked |
| TCN run/report | Self-contained synthetic generate/train/export/parity run passed; `ml/sign-recognition/configs/tcn-v1.toml`; `ml/sign-recognition/tests/test_training_and_export.py` |
| GRU run/report | Architecture/config/unit coverage exists in `ml/sign-recognition/src/signconnect_ml/models.py`, `configs/gru-v1.toml`, and `tests/test_models.py`; no genuine comparison run |
| Selection rationale | Small TCN primary plus small GRU comparison, per `docs/research/sign-language-model-candidates.md`; selection awaits identical real signer-disjoint data |
| Locked-test metrics | **BLOCKED:** no genuine locked held-out-signer test |
| Rejection/false-final report | Synthetic evaluation plumbing only; no genuine threshold evidence |
| ONNX artifact/hash | Synthetic self-contained artifact generated in a temporary run, `255224` bytes; metadata hash validated; artifact intentionally not retained/promoted |
| Python/ONNX parity report | Synthetic parity passed at `atol=1e-5`, `rtol=1e-4`; ML suite `42` passed, including provenance-renaming, safe-checkpoint, reviewed-label-outcome, OOV/reject accounting, model-state evidence binding, variable-length preprocessing, path-privacy, and redacted-validation regressions |
| Model card | **BLOCKED:** generated metadata is explicitly `mockModel: true`, `genuineSignLanguageData: false`, and promotion `BLOCKED`; no genuine model card |

**Gate pass:** a reproducible, genuinely SGSL-trained candidate meets both quality thresholds, parity tolerances, negative-behavior requirements, provenance rules, and artifact documentation.

**On failure:** keep the candidate unpromoted. Record whether the next loop changes data, labels, segmentation, features, calibration, or architecture; do not tune against the locked test signer.

## G7 — Java real-model integration

### Required work

- [ ] `backend/sign-inference-service` loads the promoted ONNX artifact through the existing singleton ONNX Runtime Java lifecycle.
- [x] Python is used only for training/evaluation/export, never in the production inference path.
- [x] Startup validates artifact checksum, model version, vocabulary version, input/output names and shapes, finite outputs, and label count.
- [x] Real mode reports `mockModel: false`; fixture mode reports `mockModel: true`.
- [x] Missing/invalid real artifacts fail readiness and predictions without fallback.
- [x] Confidence, rejection, model version, and inference latency use the existing response conventions.
- [ ] Java output probabilities and final decisions match frozen Python/ONNX fixtures within the defined tolerance.
- [x] Browser gesture serialization, realtime one-in-flight/latest-candidate fallback behavior, stale-result rejection, explicit legacy rolling stabilization, segmented occurrence separation, and idempotent captions remain intact.
- [x] Warming and repeated inference do not recreate the ONNX environment/session per request.
- [x] Logs, errors, health, traces, and metrics contain no landmark/tensor values, artifact filesystem path, credentials, caption text, or unique stream/meeting labels.

### Commands

```powershell
.\scripts\verify.ps1
npm run test:e2e:runner:self-test
git diff --check
```

### Evidence

| Field | Value |
| --- | --- |
| Java parity report | Synthetic artifact load/probe passed with `labels=3`; no frozen genuine Python/Java decision parity report |
| Startup validation tests | `backend/sign-inference-service/src/test/java/com/signconnect/inference/model/ModelContractTest.java`; `OnnxModelRuntimeTest.java`; `InferenceModelConfigurationTest.java` |
| Real-mode readiness test | Configuration and fail-closed coverage exists; no promoted `mockModel: false` artifact, so the genuine readiness requirement remains open |
| No-fallback test | `OnnxModelRuntimeTest.java` and `InferenceModelConfigurationTest.java` reject missing, invalid, mismatched, or relabelled artifacts without mock fallback |
| Session lifecycle test | `OnnxModelRuntimeTest.java`; singleton lifecycle and repeated inference are covered |
| Sensitive-log sentinel test | Inference/realtime privacy and sentinel assertions are included in backend suites; raw tensors/landmarks are not logged |
| Repository verifier result | Backend suites `183` passed (`3 + 4 + 63 + 113`); Java contract, cross-runtime parity, and benchmark-report tests are included in the `113` inference-service tests |

**Gate pass:** the exact promoted artifact runs locally in Java, agrees with frozen reference outputs, fails closed, preserves realtime behavior, and passes backend plus repository tests.

**On failure:** real mode remains unavailable. Never enable mock as an implicit recovery path.

## G8 — Browser, privacy, accessibility, and performance

### Required browser journeys

- [x] Camera off and initializing map correctly in unit/browser fixture coverage.
- [x] No person, incomplete torso, missing left/right hand, edge proximity, and poor quality are driven by MediaPipe-derived unit facts and the browser synthetic fixture.
- [x] Valid positioning reaches `Ready to sign` in MediaPipe-derived unit/browser fixture coverage.
- [ ] A reviewed supported sign traverses `Gesture in progress` → `Processing` → `Sign recognized` and creates exactly one `caption.final` in both current room participants.
- [x] A synthetic unsupported/unknown fixture reaches `Sign not recognized`, emits no caption, and returns to ready; genuine SGSL unknown-sign evidence remains open.
- [x] Unit and synthetic browser fixtures prove idle movement, incomplete gestures, held signs, and camera adjustment emit no caption.
- [ ] A genuine repeated sign after idle creates one new caption with a new caption id.
- [x] Reconnect, signer ownership, inference timeout, recovery, and stale work remain deterministic in backend and synthetic browser gates; genuine-model behavior remains separately blocked.
- [x] The UI visibly distinguishes real and mock modes and makes no full-translation claim.

### Privacy and accessibility

- [x] Network/privacy fixture inspection proves raw media never leaves the browser.
- [x] Other room participants receive no landmarks, tensors, probabilities, tracking details, status, unknown events, or credentials.
- [x] Sentinel values are absent from frontend/backend logs, errors, traces, metrics, screenshots, and test artifacts in current privacy coverage.
- [x] Default/production bundles exclude simulator, E2E fixture capture, and any development-only dataset capture route.
- [x] Canonical guidance and result changes use the single atomic polite live region without duplicate announcements.
- [x] Controls have names, roles, descriptions, visible focus, keyboard operation, visible on/off text, completed-state 320-pixel reflow, reduced-motion behavior, and automated WCAG A/AA coverage; the full Chromium gate passed.

### Performance

- [ ] Report model size, warmed Java ONNX p50/p95, end-to-end p50/p95, CPU, memory, and processed FPS.
- [x] Warmed Java ONNX p95 is below the existing `500 ms` live timeout for the explicitly synthetic artifact (`1.7464 ms`, 20-sample probe); genuine-artifact performance remains open.
- [x] Synthetic end-to-end performance is measured from completed-gesture dispatch through final caption render: one warm-up, 20 measured cycles, nearest-rank p50 `25.1 ms`, p95 `46.1 ms`, and a `1000 ms` budget.
- [ ] Performance fixtures use real mode for Milestone 4 evidence; synthetic results are labelled separately.

### Commands

```powershell
npm run test:e2e
npm run test:e2e:performance
npm run test:e2e:installed
npm run test:e2e:simulator
npm run verify:release
.\scripts\verify.ps1
git diff --check
```

### Evidence

| Field | Value |
| --- | --- |
| Supported-sign browser trace/video | **BLOCKED for genuine SGSL.** Synthetic browser path is covered by `tests/e2e/sign-recognition.spec.ts`; it is not a supported-sign accuracy claim. |
| Unknown/no-caption trace | `tests/e2e/sign-recognition.spec.ts`; `sign-recognition-privacy.spec.ts`; frontend/realtime unit fixtures; synthetic-only |
| Canonical guidance matrix | `frontend/apps/meeting/src/recognition/CanonicalStateMapper.test.ts`; `trackingQuality.test.ts`; `LandmarkCaptureController.test.ts` |
| Two-participant caption evidence | Synthetic room contract coverage in `tests/e2e/sign-recognition.spec.ts` and realtime WebSocket tests; reviewed genuine sign still blocked |
| Privacy/network report | `docs/privacy/sign-recognition-data-boundary.md`; `tests/e2e/sign-recognition-privacy.spec.ts`; strict raw-media fixture rejection |
| Accessibility report | `tests/e2e/sign-recognition-accessibility.spec.ts`; `frontend/apps/meeting/src/MeetingApp.test.tsx`; bundled Chromium `16/16` passed |
| Chromium/Chrome/Edge results | Bundled Chromium `16/16`, installed Chrome `16/16`, and installed Edge `16/16` passed on Windows; see `docs/validation/sign-recognition-browser-matrix.md`. |
| Performance report | Synthetic Java ONNX: artifact `255224` bytes, `labels=3`, p50 `0.9825 ms`, p95 `1.7464 ms`, `20` samples. Synthetic browser dispatch-to-render: one warm-up plus 20 measured samples, p50 `25.1 ms`, p95 `46.1 ms`, min `18.8 ms`, max `46.5 ms`, budget `1000 ms`. The Java benchmark/report path now also records CPU, heap, sustained FPS, and raw measured samples for a candidate artifact; no genuine-model M4 performance claim is made. |

**Gate pass:** all journeys pass using the promoted real artifact, privacy and accessibility checks pass, Java p95 is below 500 ms, and synthetic-only evidence is separately labelled.

**On failure:** preserve the trace/log and return to the earliest responsible gate: G3 contracts, G4 segmentation, G6 model, or G7 runtime. Do not weaken E2E assertions to hide an application defect.

## G9 — Final genuine-SGSL promotion

### Promotion review

- [ ] G0 through G8 are passed with linked evidence.
- [ ] The final five labels and captions have dated SGSL-fluent reviewer approval.
- [ ] Dataset, consent, usage, licence, code, dependency, model, vocabulary, and evaluation provenance are complete.
- [ ] Model card states supported vocabulary, intended use, SGSL scope, signer/population limitations, capture assumptions, non-manual limitations, rejection behavior, thresholds, failure modes, fairness slices, latency, and measured held-out performance.
- [ ] Privacy disclosure covers real-model behavior and the separate training-data boundary without weakening the zero-retention live path.
- [ ] Release configuration names the real artifact explicitly and cannot resolve to a mock artifact.
- [ ] Artifact, metadata, and vocabulary hashes are pinned together.
- [ ] A clean checkout can reproduce tests and load the exact promoted artifact.
- [ ] The roadmap may be marked complete only after this checklist evidence is reviewed.

### Final commands

```powershell
.\scripts\verify.ps1
npm run test:e2e
npm run test:e2e:performance
npm run test:e2e:installed
git diff --check
```

### Promotion evidence

| Field | Value |
| --- | --- |
| Promoted model/version/hash | |
| Vocabulary/version/hash | |
| Dataset/split hash | |
| SGSL review approval | |
| Model card | |
| Privacy approval | |
| Full test reports | |
| Release decision/reviewer/date | |

**Gate pass:** the release reviewer can reproduce and verify every genuine-model claim, all final commands pass, and no blocker below remains open.

**On failure:** do not mark Milestone 4 complete and do not describe the feature as genuine SGSL recognition.

## External-data and reviewer blocker register

The repository can implement and validate G0–G4, schemas, synthetic ML tests, training code, export code, Java fail-closed integration, and browser fixture coverage without personal training data. It cannot clear G5, genuine G6–G9, or Milestone 4 while the following external inputs are absent.

| Blocker | Required resolution | Owner/contact | Requested date | Evidence/reference | Status/recheck date |
| --- | --- | --- | --- | --- | --- |
| SGSL-fluent reviewer | Approve the five isolated signs, gloss/caption mappings, visual separability, and non-manual requirements | Project owner / SGSL community partner not yet assigned | 2026-08-30 | `docs/research/sign-language-model-candidates.md`; ADR-0003 review gate | **BLOCKED** — requested 2026-08-30; recheck when a reviewer is engaged |
| Training-data governance | Approve purpose, consent, retention, deletion, access, export, withdrawal, and downstream model invalidation | Project owner / privacy reviewer not yet assigned | 2026-08-30 | `docs/adr/0003-training-data-capture-boundary.md` defines the prerequisite; participant-facing approval absent | **BLOCKED** — requested 2026-08-30; recheck on dated approval |
| Consented SGSL recordings | Provide licensed multi-signer supported-sign, `NO_SIGN`, transition, and unknown samples with provenance | Project owner / data collection lead not yet assigned | 2026-08-30 | Training schema exists at `contracts/sign-recognition-training/v1/`; no real manifest/data | **BLOCKED** — requested 2026-08-30; no capture until governance and reviewer gates pass |
| Licence/provenance review | Confirm intended use is permitted for every external code, dataset, checkpoint, reference asset, and weight | Project owner / licence reviewer not yet assigned | 2026-08-30 | Candidate matrix records no-go decisions; no external asset downloaded | **BLOCKED** — requested 2026-08-30; recheck before any acquisition |
| Independent test signers | Preserve enough unseen signers for a locked final evaluation and browser demonstration | Project owner / study lead not yet assigned | 2026-08-30 | Manifest schema enforces split fields; no real signers enrolled | **BLOCKED** — requested 2026-08-30; recheck after approved recruitment plan |

### While blocked

- [x] Continue deterministic Milestone 3 work and non-personal synthetic/hand-authored fixtures.
- [x] Complete feature audit, candidate research, contracts, training CLI, model architectures, ONNX export tests, and Java readiness/fail-closed behavior.
- [x] Keep all synthetic and cross-language experiments labelled as engineering validation only.
- [x] Recheck blockers only when new reviewer, governance, licence, or dataset evidence exists.
- [x] Do not collect opportunistic webcam data, scrape protected SGSL media, infer consent, or lower the completion definition.

## Explicit non-completion conditions

Milestone 4 is **not complete** if any statement below is true:

- [ ] The only passing path uses the deterministic synthetic model, simulator, E2E capture fixture, generated tensors, or hand-authored labels.
- [ ] The model is trained on ASL, WLASL, Turkish Sign Language, or another language and is presented as SGSL.
- [ ] The five signs lack dated SGSL-fluent review.
- [ ] Training data lacks explicit consent, permitted-use terms, provenance, or approved retention/deletion controls.
- [ ] Fewer than five signer identities support the final signer-disjoint proof.
- [ ] Samples from one signer leak across train, validation, and final test partitions.
- [ ] Only training/recording-level accuracy is reported, or the locked held-out-signer gate is absent.
- [ ] Macro F1 is below `0.80` or false-final rate exceeds `5%` on `NO_SIGN`/unknown samples.
- [ ] `NO_SIGN`, unknown, idle, transitions, incomplete gestures, or rejection behavior is missing.
- [ ] Python/ONNX parity, Java parity, model/vocabulary shape validation, or artifact hashes are missing.
- [ ] The ONNX file loads but no genuine supported sign passes browser → Java model → stable `caption.final`.
- [ ] Unknown, idle, held, or rejected movement can create a caption.
- [ ] Real mode silently falls back to mock or reports `mockModel: true`.
- [ ] Canonical states are hard-coded/demo-driven instead of derived from camera, MediaPipe, segmentation, and model facts.
- [ ] Intermediate recognition data is persisted, logged, broadcast, replayed, or reused for training outside its separately authorized boundary.
- [ ] Raw media leaves the browser or a cloud AI service is required.
- [ ] Java ONNX p95 is at or above the 500 ms live timeout, or end-to-end latency is unmeasured.
- [ ] Any required repository, ML, contract, privacy, accessibility, or E2E test is failing.
- [ ] The model card, target language, licences, limitations, or real/mock UI disclosure is incomplete.
- [ ] Any external blocker remains open.

Milestone 3 is **not complete** if guidance is mocked, camera adjustment starts gestures, held signs repeat, idle does not separate repetitions, fixtures do not preserve handedness/missing-point semantics, or the running accessible UI has not been validated.
