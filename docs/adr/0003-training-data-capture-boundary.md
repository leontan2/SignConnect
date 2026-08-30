# ADR-0003: Isolate consented local training-data capture from live recognition

**Date**: 2026-08-30
**Status**: accepted as a prerequisite; capture remains disabled until the review gates below pass
**Deciders**: SignConnect product and engineering

## Context

Milestone 4 needs a small, signer-independent Singapore Sign Language (SGSL) landmark dataset because no deployable SGSL model or dataset has yet satisfied the project's language, licence, provenance, and input-contract requirements. The live meeting path deliberately retains neither raw media nor landmarks and its recognition consent authorizes only transient inference. Reusing that consent or silently collecting live-room traffic would violate the existing boundary and would prevent participants from making an informed choice about model training.

## Decision

SignConnect may add a separate development-only capture tool for explicitly consented training and evaluation. It is an offline, loopback-only workflow that exports accepted normalized landmark sequences to a user-chosen local destination; it is not part of the meeting, realtime, inference, or production application.

Starting live recognition, joining a room, or accepting live landmark transmission **never authorizes collection, retention, labeling, training, evaluation, or model creation**. Training capture requires its own current consent record before the camera starts and an explicit accept decision for every take.

### Permitted purpose and usage rights

Before capture, the participant must receive and affirm a versioned notice that states:

- the study purpose: developing and evaluating a limited supported-sign SignConnect model;
- the target language, reviewed label set, requested repetitions, and capture conditions;
- that normalized hand and upper-body landmarks are sensitive derived data even though raw video is not retained;
- that accepted samples may be used for preprocessing, signer-independent training/evaluation, ONNX export, and internal quality review;
- who may access the local dataset, the retention expiry, the deletion process, and how to withdraw using the issued withdrawal code;
- that participation is voluntary, does not affect meeting access, and is distinct from live recognition consent;
- known risks, including possible re-identification from movement patterns and model errors across signers;
- that data will not be sold, published, redistributed, uploaded, used for identity or biometric profiling, used to train unrelated models, or used for a broader product purpose;
- that cloud processing, third-party sharing, commercial redistribution, public dataset release, and any new purpose require a new reviewed notice and separate affirmative consent.

Consent must be affirmative and must not be bundled with application terms, camera permission, room access, or live recognition. The notice version, purpose version, consent time, random signer ID, retention expiry, and withdrawal code are recorded in a local consent receipt. The dataset contains only the receipt identifier needed to prove authorization; it contains no name, email address, room ID, meeting ID, account ID, IP address, device fingerprint, or contact detail.

### SGSL and vocabulary review gate

An SGSL-fluent Deaf signer or qualified linguistic reviewer must approve the exact label IDs, caption intents, reference instructions, known regional variants, and any required non-manual features before data for those labels is captured. The review record must identify the reviewer role, date, vocabulary version, approved uses, limitations, and rejected or ambiguous labels.

Reviewer approval does not substitute for participant consent. Until both the vocabulary review and consent materials are approved, the capture tool remains unavailable and no output may be represented as validated SGSL recognition.

### Signer and sample identity

Each participant receives a cryptographically random signer ID and withdrawal code. Neither value may be derived from a name, account, room, device, timestamp, or other direct identifier. Sample IDs are random and are associated with the signer ID only in the local manifest.

The signer ID removes direct identity from the dataset, but SignConnect does not claim that body landmarks are irreversibly anonymous. Documentation, access controls, and deletion requirements continue to treat every landmark sequence as sensitive pseudonymous data.

### Capture, accept, discard, and export

- Raw camera frames exist only long enough for local MediaPipe processing and are released after each frame. Raw frames, screenshots, video, audio, pixels, blobs, object URLs, and base64 media are never recorded or exported.
- Before take acceptance, normalized landmarks and calibration values exist only in bounded page memory. The tool must not write them to browser storage, a temporary file, a service worker, logs, crash reports, or a server.
- Accept and discard are explicit per-take actions. Accept makes a take eligible for the next local export; discard immediately removes all references to that take. Closing, refreshing, cancelling, disabling the camera, or encountering an error discards every unexported take.
- Export is a separate explicit action after take review. It writes only accepted normalized landmark sequences and the minimum versioned manifest metadata needed for training: random sample and signer IDs, reviewed label ID, language, handedness, capture-condition categories, consent/purpose version, timestamps, feature contract version, and retention expiry.
- Export must never include reference media, raw media, direct identifiers, room credentials, captions from a live meeting, inference results, or unaccepted takes.
- The tool opens no meeting WebSocket, does not call the realtime or inference services, and does not send analytics, telemetry, crash attachments, or network requests containing capture data.

### Environment and network isolation

The capture code and route must be absent from production and default builds. Enabling it requires both an explicit compile-time development flag and a dedicated local capture profile. A runtime environment variable alone must not expose production code that was bundled accidentally.

The capture server binds only to `127.0.0.1` or `::1`, uses no wildcard CORS, and rejects non-loopback `Host`, `Origin`, and forwarded-host/address values. It must not listen on a LAN interface, provide remote access, or use a cloud storage or model-serving endpoint. The training tools consume only an explicitly selected local dataset path and do not discover, download, synchronize, or upload data automatically.

### Retention, withdrawal, and deletion

- Raw media has zero retention and is never written.
- Discarded, rejected, cancelled, and unexported takes have zero retention beyond the in-memory action needed to clear them.
- Each approved study manifest sets an absolute `retentionExpiresAt` for accepted source landmark exports. It may be shorter but must not be more than 90 calendar days after capture. Open-ended retention is prohibited.
- Accepted exports stay only in the documented local restricted directory and are accessible only to the authorized study team. Copies, backups, synchronization folders, removable-media copies, and shadow archives are prohibited.
- On withdrawal or expiry, the source samples, derived training caches, augmented copies, evaluation extracts, and affected unpromoted checkpoints are deleted within seven calendar days. A non-sensitive tombstone may retain only the random signer/sample IDs, deletion reason, and deletion date so the deletion can be audited.
- A model trained with withdrawn or expired samples cannot be promoted or distributed. It and its evaluation report must be deleted, and training must be rerun without those samples before promotion. Any already promoted internal artifact is withdrawn and replaced within 30 calendar days; external distribution is outside this ADR and remains prohibited.
- The local capture workflow may be enabled only when the owner has a tested inventory-and-delete command that can find every artifact for a signer ID and enforce these deadlines.

### Repository and artifact exclusions

Private capture and training artifacts must not enter Git, package registries, CI artifacts, issue attachments, or code-review uploads. Repository ignore rules and automated staged-file/CI checks must reject, by default:

- capture, dataset, consent-receipt, and private manifest directories;
- raw media and browser recordings;
- training runs, caches, augmented samples, checkpoints, and tensor dumps;
- unreviewed ONNX files and other generated model binaries;
- files containing signer-level landmark sequences or withdrawal codes.

Only a specifically promoted model artifact may be allowlisted after SGSL review, licence and consent verification, signer-independent evaluation, withdrawal audit, model-card publication, checksum recording, and explicit engineering approval. Synthetic fixtures that cannot describe a real person may remain in Git when they are clearly labeled and contain no captured participant data.

### Required verification before enablement

Automated tests must prove that:

- production and default bundles contain no capture route, capture module, or enabling fallback;
- the local profile rejects non-loopback access and capture-data network requests;
- camera permission, live-room consent, and Start recognition cannot create a training sample;
- no raw media or unaccepted landmarks enter browser storage, files, logs, requests, or exports;
- accept, discard, cancel, refresh, camera stop, and error paths follow the lifecycle above;
- exported schemas reject direct identifiers, raw-media fields, unknown labels, missing consent/review versions, and retention dates beyond 90 days;
- deletion inventory covers source samples and every derivative associated with a signer ID;
- private artifact patterns and sentinel landmark values are rejected by repository guards;
- the UI labels the workflow as local development dataset capture and never as validated SGSL recognition.

## Alternatives Considered

### Reuse live recognition traffic

- **Pros**: No separate capture workflow.
- **Cons**: Live consent does not authorize retention or training, samples lack reviewed labels, and meeting participants cannot make an informed training choice.
- **Why not**: It violates the accepted live data boundary and is prohibited.

### Upload captures to a shared backend or cloud bucket

- **Pros**: Easier collaboration and centralized retention enforcement.
- **Cons**: Materially expands security, access-control, breach, transfer, and deletion obligations.
- **Why not**: The first proof needs only a small local dataset and does not justify a new server boundary.

### Retain raw video for future feature extraction

- **Pros**: Preserves information missing from the current landmark contract.
- **Cons**: Greatly increases privacy risk and contradicts SignConnect's raw-video boundary.
- **Why not**: The proof is limited to the existing normalized landmark representation.

## Consequences

### Positive

- Training authorization is explicit, auditable, purpose-limited, and independent of meetings.
- Raw media still never leaves transient browser processing.
- SGSL review precedes labeling, reducing linguistic harm and misleading claims.
- Local-only capture avoids introducing a new production data service.

### Negative

- Multi-person collection and collaboration are operationally manual.
- Ninety-day source retention and withdrawal-aware retraining add dataset-management work.
- Model training cannot begin until consent materials, deletion tooling, repository guards, and SGSL vocabulary review are complete.

### Risks

- **Landmark re-identification**: treat random-ID samples as sensitive, restrict local access, minimize retention, and prohibit redistribution.
- **Consent drift**: bind every sample to versioned purpose, consent, vocabulary, and retention metadata; reject mismatches at training time.
- **Accidental repository disclosure**: combine narrow ignore patterns with staged-file and CI content guards.
- **Misleading SGSL claims**: require review records and explicit experimental/development labeling through model promotion.
