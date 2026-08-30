# SignConnect sign-recognition ML

This package is the reproducible training and export lane for the SignConnect
`[batch, 30 frames, 224 features]` landmark contract. It contains a temporal
convolution baseline and a GRU comparison model. It does **not** contain a
trained Singapore Sign Language (SgSL) model or real participant data.

## Safety and provenance boundary

The included fixture generator creates obvious, separable numeric patterns.
Their schema-bound `provenance.kind` is `NON_PRODUCTION_SYNTHETIC` with typed
generator evidence; this classification never comes from `datasetId`. They are
not signs and must never be described
as SgSL performance evidence. Synthetic checkpoints emit shared-schema model
metadata with `mockModel: true`, `genuineSignLanguageData: false`, and a
`productionPromotion.status` of `BLOCKED`.

The authoritative schemas are
`contracts/sign-recognition-training/v1/dataset-manifest.schema.json` and
`model-metadata.schema.json`. An export can claim genuine SgSL data only from
a non-synthetic manifest that passes that schema and its consent/usage-rights
semantic gates. Production remains blocked until the separate SGSL-fluent Deaf
review, evaluation, parity, governance, and measured warmed-Java latency gates
pass. Zero latency in exported metadata means unmeasured and cannot satisfy an
`APPROVED` promotion. The
checkpoint embeds the manifest SHA-256; export rejects a different manifest.
Training selects a checkpoint from validation data only. The locked test split
is evaluated once, using the checkpoint's locked confidence threshold, and the
complete class, confusion-matrix, NO_SIGN, and rejection evidence is then bound
into the finalized checkpoint and copied into exported model metadata. Each
rich evaluation also carries a canonical SHA-256 over the selected tensor
names, dtypes, shapes, and bytes; loading rejects evidence paired with changed
weights. Legacy flat evidence remains load-compatible, but its exported
metadata is explicitly blocked as unbound.

`OUT_OF_VOCABULARY` is the reserved measured-unknown class. Its samples remain
explicit in per-class evidence, while exports always declare its outcome as
`REJECT` with a null caption. It can therefore never become caption text even
when its model probability is highest.

Real data belongs outside Git. Put only pseudonymous relative paths in the
manifest. Never place video, images, names, emails, consent forms, or raw
landmarks in this repository.

## Setup

```powershell
uv venv
uv sync --extra test
```

## Offline preprocessing

The file-only `preprocess` command converts a variable-length sequence of
already-normalized landmarks into one deterministic `[30,224]` training
window. It has no camera, upload, image, or video capture route. Keep both the
input and output in approved storage outside this repository: normalized
landmarks are still sensitive derived participant data.

Input is a strict JSON object with `schemaVersion: 1`,
`featureLayoutVersion: "mediapipe-holistic-224-v1"`, and a `frames` array.
Each frame contains only `timestampMs` and exactly 224 finite `features` in the
canonical `x, y, z, presence` layout. Timestamps must be strictly increasing;
the default maximum adjacent gap is 200 ms. Missing landmarks use
`[0, 0, 0, 0]`. Extra fields, including raw-media references or payloads, are
rejected.

```powershell
uv run signconnect-ml preprocess --input D:\approved-data\gesture.json --output D:\approved-data\gesture.npz
```

Use `--maximum-frame-gap-ms` only when the approved collection protocol has a
different continuity limit. The NPZ contains only the fixed `features` array;
source timestamps are not retained.

## Pipeline

Generate a mechanical smoke-test dataset:

```powershell
uv run signconnect-ml generate-synthetic --output fixtures/NON_PRODUCTION_SYNTHETIC/generated
```

Train the TCN baseline or GRU comparison:

```powershell
uv run signconnect-ml train --config configs/tcn-v1.toml
uv run signconnect-ml train --config configs/gru-v1.toml
```

Re-evaluate an immutable checkpoint/split pair:

```powershell
uv run signconnect-ml evaluate --checkpoint runs/tcn-v1/checkpoint.pt --manifest fixtures/NON_PRODUCTION_SYNTHETIC/generated/manifest.json --split-file runs/tcn-v1/split.json --output runs/tcn-v1/evaluation-rerun.json
```

Export and verify ONNX parity:

```powershell
uv run signconnect-ml export --checkpoint runs/tcn-v1/checkpoint.pt --manifest fixtures/NON_PRODUCTION_SYNTHETIC/generated/manifest.json --output artifacts/sign-v1.onnx --verify-parity
```

The synthetic config is intentionally not promotion-capable. For real SgSL
training, copy a config and point it to an approved external manifest.

## Outputs

- `split.json`: a deterministic projection of the manifest's immutable signer-group assignments.
- `checkpoint.pt`: model weights, architecture, labels, seed, manifest hash, and the selected validation or locked final-test evidence.
- `evaluation.json`: macro-F1, per-class precision/recall/F1, confusion matrix, NO_SIGN false finals, and measured unknown rejection behavior.
- `*.onnx`: fixed deployment graph with input `[1,30,224]`; PyTorch models still accept batches.
- `*.metadata.json`: the shared model-metadata contract including vocabulary, provenance, evaluation, parity, runtime, review, and promotion gates.

Run tests with `uv run pytest`. The parity suite compares PyTorch model
probabilities with ONNX Runtime probabilities using absolute tolerance `1e-5`
and relative tolerance `1e-4`.
