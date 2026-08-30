# Sign-recognition training contracts v1

These two JSON Schemas are the authoritative boundary between dataset tooling,
the Python training/export pipeline, and the Java ONNX runtime:

- `dataset-manifest.schema.json` describes consented, pseudonymized landmark
  artifacts, the exact `shoulder-midpoint-shoulder-width-v1` preprocessing
  contract, and immutable signer-independent split assignments.
- `model-metadata.schema.json` describes the exported model, vocabulary,
  evaluation evidence, ONNX parity, runtime target, and production decision.

Dataset origin is explicit and independent of `datasetId`. The manifest-level
`provenance.kind` is either `NON_PRODUCTION_SYNTHETIC` with bound generator
evidence or `ATTESTED_SGSL_DATASET` with a hashed provenance attestation.
Renaming a dataset cannot change this classification. The manifest SHA-256 in
model metadata binds the exported model back to that exact provenance record.

There is one model metadata document per ONNX artifact. The Python exporter
emits it and the Java runtime consumes that same file; a second labels file or
runtime-only metadata dialect is not authoritative.

## Runtime tensor and decision contract

The model metadata fixes the Java runtime boundary exactly:

- root `artifactSha256` authenticates the ONNX bytes;
- input `features` is `FLOAT32` with shape `[1, 30, 224]`;
- normalization is `shoulder-midpoint-shoulder-width-v1`;
- feature order is left hand landmarks 0-20, right hand landmarks 0-20, then
  pose landmarks 11-24, each encoded as `x, y, z, presence`;
- output `probabilities` is `FLOAT32`, has shape `[1, labels.length]`, and uses
  `softmax-class-probabilities-v1` semantics;
- `decision.minimumConfidence` is the runtime recognition threshold; and
- label indexes are contiguous and equal their array positions.

Exactly one indexed label has outcome `NO_SIGN`, id `NO_SIGN`, and a null
`captionText`. At least one label has outcome `SIGN` and a nonblank caption.
An optional `REJECT` class must use a non-`NO_SIGN` id and a null caption. The
semantic validator enforces the cross-field output-size, index, and complete
SGSL-review constraints that JSON Schema cannot express directly.

The ML pipeline owns emitted manifests and metadata. Runtime consumers must
reject artifacts that fail either schema. Privacy approval and an SGSL-fluent
Deaf reviewer own the consent/usage-rights and language-review attestations;
an application developer cannot self-assert them.

## Privacy boundary

Dataset records contain relative landmark-artifact paths and SHA-256 digests,
not tensors, raw video, images, names, email addresses, or meeting participant
identifiers. `additionalProperties: false`, pseudonymous identifier patterns,
and the restricted artifact-path pattern make accidental raw-media fields and
path traversal contract violations.

Dataset contract v1 accepts only `.npz` artifacts with media type
`application/x-npz`. Each archive represents exactly 30 frames and 224 features
per frame; the loader additionally requires the archive to contain only a
finite `features` array with shape `[30, 224]`. Other extensions, media types,
or frame counts require a future contract version and matching loader support.

The fixture attestations and digests are test data only. A fixture that validates
does not prove that a real participant consented, that a real SGSL review
occurred, or that a deployable model exists.

## Fail-closed promotion

`productionPromotion.status: APPROVED` is valid only for a non-mock model trained
on genuine SGSL data with verified consent and usage rights, complete SGSL review,
signer-independent evaluation with no signer overlap, the required quality
thresholds, verified ONNX parity, and warmed Java CPU p95 latency at or below
500 ms. `runtime.warmedP95LatencyMs: 0` is the explicit unmeasured sentinel and
is structurally invalid for `APPROVED`; it remains valid for a `BLOCKED`
synthetic export. Otherwise metadata must use `BLOCKED` with at least one reason.

JSON Schema cannot compare signer IDs across sample records or prove every sign
label is included in the review. Therefore consumers and CI must also run the
contract-local semantic validator:

```powershell
node contracts/sign-recognition-training/v1/validate-fixtures.mjs
```

Any breaking shape or semantic change requires a new contract version.
