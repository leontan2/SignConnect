# Real-Time Sign-Language Model Implementation Plan

Status: bounded ASL research implementation complete; production SgSL phase remains gated
Date: 2026-08-31
Primary implementation branch: `codex/milestone-3-live-sign-recognition`

## 1. Decision summary

SignConnect uses a **local landmark-sequence classifier** as its first real sign-language model. The existing MediaPipe pipeline remains responsible for finding hands and pose landmarks, measuring capture quality, and segmenting gestures. The selected research classifier is the official OpenHands WLASL SL-GCN wrapped into a self-contained SignConnect ONNX graph; the repository-owned TCN/GRU lane remains the future SgSL training route.

The implemented first deliverable is an explicitly labelled **ASL research model pack** containing the ten core isolated concepts plus a conservative `NO_SIGN` adapter outcome. It proves the complete webcam-to-caption workflow with a genuinely ASL-trained checkpoint while preserving the application's `[1, 30, 224]` inference boundary. It is not presented as SgSL or as continuous sign-language translation.

Implementation evidence: the official Hello clip passed through Chromium as a virtual webcam, browser MediaPipe, the bounded gesture segmenter, six WebSocket chunks, Java ONNX Runtime, and the rendered transcript as `Hello` with `mockModel: false`. The pack is reproducible with `scripts/setup-asl-research-model.ps1`; WLASL rights and the absence of signer-independent product validation keep production promotion blocked.

The production lane remains **SgSL**. Once approved, signer-disjoint SgSL training data and qualified language review are available, the same training, export, serving, rejection, and UI pipeline will train and promote an SgSL model pack without another runtime rewrite.

This choice is best for the current application because it:

- keeps inference private and offline;
- fits a normal CPU and the current browser-to-backend transport;
- can distinguish supported signs, `NO_SIGN`, and rejected/unknown input;
- avoids streaming raw camera frames to the backend;
- is small enough to train, export to ONNX, benchmark, and replace;
- preserves the current 13 canonical recognition states and transcript workflow.

It does **not** claim to recognize every sign language. ASL, SgSL, BSL, ISL, and other sign languages need separate labelled vocabularies and evaluation. The long-term design is a shared runtime with separately versioned language/model packs.

## 2. Architecture decision

| Option | Fit for SignConnect | Decision |
| --- | --- | --- |
| Raw-video transformer/CNN | Higher compute and memory, sends or processes image tensors, difficult CPU latency, limited open-set rejection | Do not use for the first model |
| Landmark temporal model | Matches the current capture pipeline, small tensors, fast CPU inference, privacy-friendly | **Primary architecture** |
| Hybrid landmarks + cropped video | May help signs whose meaning depends on facial/non-manual features, but adds two pipelines and more compute | Consider only if measured errors prove landmarks insufficient |

The first vocabulary will avoid signs that cannot be distinguished without facial grammar or other non-manual signals. If error analysis later proves that this excludes important SgSL signs, that evidence will trigger a versioned hybrid-input contract rather than an unplanned change to the current API.

## 3. Open-source model and dataset decision

| Candidate | Useful contribution | Why it is not the production drop-in |
| --- | --- | --- |
| ASL Citizen | Large isolated-ASL dataset, signer-disjoint official splits, published code/checkpoints | Official ST-GCN input is incompatible with `[30,224]`; dataset is restricted to noncommercial research and cannot be shipped with the app |
| OpenHands | Good reference architecture and Apache-2.0 code | Released checkpoints are language/dataset-specific closed-set models; the WLASL checkpoint has different landmarks, sequence length, labels, and no `NO_SIGN` class |
| SignBART | Promising compact landmark architecture | License, weight provenance, label contract, rejection behaviour, and ONNX/CPU evidence are not yet sufficient for promotion |
| SignSpeak / SignLens | Demonstrate webcam landmark recognition | Small portfolio vocabularies, weak or incomplete evaluation/provenance, no calibrated unknown rejection |
| VideoMAE and related video backbones | Strong raw-video research baseline | Too heavy for the first local CPU path and not a sign-language/open-set solution by itself |
| MediaPipe Gesture Recognizer | Hand/pose tracking and generic gesture cues | It is not a semantic sign-language recognizer |

### Selected approach

1. Run a pretrained-first compatibility spike before custom training. Audit and pin an exact OpenHands or official ASL Citizen revision/checkpoint outside the product source tree.
2. Test its licence, labels, preprocessing, CPU latency, webcam behaviour, and exportability before allowing it into the application.
3. Prefer transfer learning when viable: keep a compatible pretrained temporal encoder, replace its classifier with SignConnect's language-specific vocabulary plus `NO_SIGN`, and fine-tune only the head or final blocks.
4. Retain the repository's existing TCN and GRU implementations as small reproducible baselines. They remain the fallback when a pretrained model is incompatible, unlicensed, too slow, or inaccurate.
5. For the immediate noncommercial research proof, extract SignConnect's exact landmark representation from a clearly documented subset of ASL Citizen videos.
6. Compare the fine-tuned pretrained candidate, TCN, and GRU, then promote the smallest model that passes the accuracy, rejection, parity, and latency gates.
7. Keep restricted source videos, derived samples, checkpoints, and research artifacts outside Git and outside redistributable releases.
8. If the intended deployment becomes commercial, skip restricted ASL Citizen materials and proceed directly to licensed/consented SgSL data.

SignBART remains a contingent experiment only if its authors provide an explicit code-and-weights license, a trustworthy label map, and reproducible checkpoint provenance.

### Pretrained acceleration lane

OpenHands is the primary multilingual transfer-learning candidate because its Apache-2.0 toolkit supports pose-based isolated recognition, monolingual pretraining, multilingual pretraining, and fine-tuning across several public datasets. It is **not** a universal ready-to-run sign classifier: dataset licences remain independent, released heads use dataset-specific vocabularies, SgSL is not included, sign detection and continuous recognition are unfinished, and the project is no longer actively maintained.

The compatibility spike will therefore:

- clone or download an exact audited revision/checkpoint into a Git-ignored research cache;
- record upstream URL, commit, checksum, code licence, weight licence, dataset lineage, languages, labels, and preprocessing contract;
- run it in an isolated environment rather than adding its dependencies directly to the backend;
- test whether its encoder can consume a losslessly derived view of SignConnect landmarks;
- benchmark it against the repository TCN and GRU on identical signer-disjoint data;
- import only an auditable, redistributable artifact into a release; otherwise keep it local research-only;
- replace and fine-tune the classification head for one explicit language pack instead of merging unrelated language labels.

The official ASL Citizen checkpoint is the preferred direct pretrained ASL research comparison. SignBART is a technical comparison only until its licensing is clarified. No external repository will be copied wholesale into the production codebase.

### Vocabulary policy

The immutable core vocabulary is:

`HELLO`, `THANK_YOU`, `YES`, `NO`, `HELP`, `REPEAT`, `SLOWER`, `UNDERSTAND`, `FINISHED`, `GOODBYE`, and `NO_SIGN`.

Additional signs will be selected in data-qualified tiers rather than adding every available dataset label at once:

- Conversation: `PLEASE`, `SORRY`, `AGAIN`, `WAIT`, `STOP`, `GOOD`, `BAD`, `WANT`, `NEED`.
- Questions and identity: `WHAT`, `WHERE`, `WHO`, `WHEN`, `HOW`, `NAME`, `ME`, `YOU`.
- Everyday needs: `WATER`, `FOOD`, `TOILET`, `HOME`, `WORK`, `FRIEND`.
- Safety and care: `EMERGENCY`, `PAIN`, `SICK`, `DOCTOR`, `HOSPITAL`, `POLICE`.

A candidate enters a trained pack only when it has:

- an unambiguous language-specific gloss and reviewer-approved display meaning;
- sufficient licensed samples from multiple signers;
- explicit handling of accepted regional or handedness variants;
- adequate per-class validation and test recall;
- no unresolved confusion with another supported sign.

ASL and SgSL labels remain namespaced and versioned separately even when their English display text matches. For example, an ASL `HELP` sample cannot silently become the SgSL `HELP` training class without SgSL review.

## 4. Prediction contract

### Input

- Shape: float32 `[1, 30, 224]`.
- Per frame: left-hand landmarks, right-hand landmarks, and the existing upper-body pose subset, in the repository's current field order.
- The browser owns gesture segmentation, handedness normalization, frame resampling, and quality signals.
- Training extraction must pin the MediaPipe version and reproduce the browser's mirroring, missing-landmark, presence, normalization, and resampling rules.

### Model output

- Shape: float32 `[1, N]` logits.
- Labels: exactly one trained `NO_SIGN` class plus the versioned supported vocabulary.
- Model metadata: language, vocabulary version, feature schema version, sequence length, label order, preprocessing version, training-data declaration, license/use mode, model checksum, metrics, thresholds, and build commit.

### Runtime decision

The runtime will not blindly emit the highest-probability class.

1. `NO_SIGN` wins when its calibrated probability is dominant.
2. A supported sign becomes a candidate only when top-1 confidence and the top-1/top-2 margin pass their calibrated thresholds.
3. The candidate must remain temporally stable for the configured number of inference results.
4. Otherwise the result maps to the existing `unrecognized`, capture-quality, or in-progress state.
5. Only one stable `caption.final` event is emitted per completed gesture; held signs and repeated chunks must not duplicate the transcript.

Out-of-vocabulary signs are reserved for calibration and unknown-rejection evaluation. Ordinary movement, idle hands, partial gestures, transitions, and empty scenes provide the trained `NO_SIGN` examples.

## 5. Implementation phases

### Phase 0 — use and licensing gate

- Confirm whether the immediate pack is local/noncommercial research or distributable product work.
- Record the selected language as `asl` for the research pack; keep the product target as `sls` for SgSL.
- Freeze the ten core labels and `NO_SIGN`.
- Build a candidate inventory for the extension tiers, including dataset counts, signer counts, licence, accepted variants, and landmark suitability.
- Promote only extension signs with sufficient samples and no essential unmodelled facial-grammar dependency.
- Freeze the exact model-pack vocabulary and exclusions before each training run.

Gate: no dataset is downloaded or model trained until its use, storage, derived-artifact, and redistribution conditions are documented.

### Phase 1 — reproducible data pipeline

- Add a manifest-driven acquisition step that verifies expected files and hashes but does not commit restricted data.
- Implement an offline video-to-landmark extractor using the exact `[30,224]` feature schema.
- Add deterministic cache keys containing video hash, extractor version, feature schema, and preprocessing configuration.
- Preserve official signer-disjoint train/validation/test splits.
- Add a consented local negative-capture workflow for idle, transitions, ordinary movement, partial hands, repeated signs, and empty frames.
- Add out-of-vocabulary ASL signs to the evaluation set, not to the supported label list.

Gate: a checked-in synthetic fixture must produce equivalent ordered features in the offline extractor and the frontend feature builder within a defined numeric tolerance.

### Phase 2 — baseline training and calibration

- Adapt and fine-tune the approved pretrained encoder when the compatibility spike passes.
- Train seeded TCN and GRU baselines from the same immutable manifest.
- Log configuration, data hashes, split hashes, environment, checkpoints, and metrics.
- Measure per-class precision/recall/F1, macro-F1, confusion matrix, calibration error, `NO_SIGN` false positives, and out-of-vocabulary false acceptance.
- Calibrate confidence, top-two margin, and temporal-stability thresholds on validation data only.
- Evaluate signer-disjoint test data once after the model and thresholds are frozen.

Provisional promotion gates:

- supported-sign macro-F1 at least `0.80` on the signer-disjoint test set;
- out-of-vocabulary false acceptance at most `5%`;
- ordinary/no-sign false acceptance at most `2%` of completed negative segments;
- no class below `0.65` recall without an explicit waiver and user-facing limitation;
- results reproducible from the recorded seed/config within the agreed tolerance.

The pretrained candidate wins only if it passes every mandatory gate and materially improves supported-sign accuracy, unknown rejection, or data efficiency. A larger vocabulary alone is not sufficient for promotion.

These are minimum promotion gates for the small proof vocabulary, not a claim of general sign-language accuracy.

### Phase 3 — ONNX export and runtime promotion

- Export the winning checkpoint to ONNX with static feature dimension and validated sequence length.
- Run framework-versus-ONNX parity across normal, missing-landmark, no-sign, and boundary fixtures.
- Generate a signed/checksummed model manifest and vocabulary metadata.
- Load the model through the existing Java ONNX Runtime service.
- Fail closed when artifacts, schema, labels, metadata, or checksum do not match; never silently switch to mock recognition.
- Benchmark cold start, memory, median latency, and p95 latency on the user's CPU.

Performance gates:

- p95 model inference at most `100 ms` on the target CPU;
- p95 backend inference round trip at most `500 ms` on localhost;
- final caption normally appears within `1.5 seconds` of a gesture ending;
- application remains responsive during a sustained camera session.

### Phase 4 — live product integration

- Keep the existing browser segmentation and six ordered `[5,224]` chunk protocol.
- Send model language/version in readiness and diagnostic responses.
- Map every backend result through the canonical recognition-state mapper.
- Display the supported result, confidence, and active language/model pack on the video overlay.
- Label the first pack clearly as **ASL research vocabulary** so it cannot be confused with SgSL.
- Add timestamped participant attribution to `caption.final` transcript entries.
- Preserve privacy disclosures and local-only behaviour.

Gate: the UI must distinguish camera/quality problems, gesture in progress, unsupported/uncertain input, `NO_SIGN`, and a stable recognized sign. It must not remain indefinitely on “gesture in progress” after a segment ends.

### Phase 5 — automated and physical-camera validation

Automated coverage:

- Python extractor, dataset, split, training-smoke, calibration, robustness, and reproducibility tests;
- ONNX export and numerical-parity tests;
- Java model contract, readiness, rejection, event-state, deduplication, and performance tests;
- frontend landmark ordering, segmentation timeout, canonical mapping, overlay, and transcript tests;
- browser end-to-end tests with deterministic landmark fixtures.

Physical-camera acceptance matrix:

- every supported sign from two different people;
- left- and right-handed execution where linguistically valid;
- idle hands and no person;
- ordinary non-sign movement;
- unsupported ASL signs;
- partial/out-of-frame hands and low capture quality;
- a held sign, repeated sign, and two different consecutive signs;
- backend unavailable and incompatible model metadata.

The session passes only when supported signs create one correct on-video result and one matching transcript event, while unknown and idle cases do not create false captions.

### Phase 6 — SgSL production pack

- Establish approved SgSL vocabulary, qualified language review, participant consent, licensing, and signer-diverse collection.
- Reuse the same extractor, manifests, signer-disjoint evaluation, model comparison, rejection calibration, ONNX export, and serving gates.
- Add non-manual/facial features only if vocabulary analysis and measured error demonstrate the need; introduce them as a versioned feature schema.
- Promote SgSL only when per-class review and physical-camera validation meet the same or stricter gates.
- Keep ASL and SgSL packs separately named, versioned, tested, and selectable; never merge their labels into an unlabeled “universal” vocabulary.

## 6. Iteration loop checklist

Each iteration must complete this loop before another architecture or dataset change is accepted:

- [ ] Freeze one hypothesis and the exact evaluation slice.
- [ ] Train from an immutable manifest with a recorded seed and environment.
- [ ] Evaluate supported, `NO_SIGN`, out-of-vocabulary, and capture-quality cases.
- [ ] Inspect per-class confusions and physical-camera failures.
- [ ] Change one major variable: data, preprocessing, architecture, or calibration.
- [ ] Re-run parity, regression, latency, and false-caption gates.
- [ ] Promote only a versioned artifact that beats the current baseline and passes every mandatory gate.
- [ ] Record rejected experiments and the reason so they are not repeated.

## 7. Branch and delivery sequence

1. Preserve and finish the current Milestone 3 recognition-state and UI hardening on `codex/milestone-3-live-sign-recognition`.
2. Implement Phases 0–5 on that branch because they complete the promised Milestone 3 live recognition workflow.
3. Keep datasets, restricted derived features, local captures, checkpoints, and research-only ONNX files out of Git; commit only code, schemas, tiny synthetic fixtures, reports, and redistributable metadata.
4. After Milestone 3 is reviewed and merged, create `codex/milestone-4-sgsl-model-pack` from the updated main branch for the governed SgSL production pack and broader model-pack management.
5. Use no more than five parallel agents in any later execution, and do not run frontend/backend servers concurrently with model training unless needed for an acceptance test.

## 8. Definition of done

The real-model milestone is complete only when:

- a real, non-mock ONNX model recognizes the frozen isolated-sign vocabulary from the physical webcam;
- every core vocabulary item and every promoted extension item passes its per-class acceptance tests;
- the model has one trained `NO_SIGN` class and calibrated unknown rejection;
- every recognized result maps through the existing canonical states and produces exactly one timestamped `caption.final` transcript entry;
- incorrect, unknown, idle, or poor-quality inputs do not force a supported label;
- model language, vocabulary, version, preprocessing, license/use mode, and metrics are visible in metadata/readiness;
- training and export are reproducible from manifests without committing restricted data;
- frontend, backend, ML, ONNX-parity, end-to-end, and physical-camera checks pass;
- the app has no silent mock fallback and can roll back to the previous versioned model pack;
- the UI makes the ASL research limitation or SgSL production status unmistakable.

## 9. Evidence sources

- [ASL Citizen code and checkpoints](https://github.com/microsoft/ASL-citizen-code)
- [ASL Citizen datasheet](https://www.microsoft.com/en-us/research/project/asl-citizen/datasheet/)
- [ASL Citizen dataset license](https://www.microsoft.com/en-us/research/project/asl-citizen/dataset-license/)
- [OpenHands](https://github.com/AI4Bharat/OpenHands)
- [SignBART](https://github.com/TinhNguyen2312/SignBart)
- [SignSpeak](https://github.com/UnmannedArchive/signspeak)
- [SignLens](https://github.com/SiD-array/SignLens-RealTime-ASL-Recognition)
- [VideoMAE](https://github.com/MCG-NJU/VideoMAE)
- [MediaPipe Gesture Recognizer](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer)
- [WLASL](https://github.com/dxli94/WLASL)
