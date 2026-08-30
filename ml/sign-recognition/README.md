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

Real data belongs outside Git. Put only pseudonymous relative paths in the
manifest. Never place video, images, names, emails, consent forms, or raw
landmarks in this repository.

## Setup

```powershell
uv venv
uv sync --extra test
```

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
- `checkpoint.pt`: model weights, architecture, labels, seed, and manifest hash.
- `evaluation.json`: macro-F1, per-class F1, accuracy, and false-final rate.
- `*.onnx`: fixed deployment graph with input `[1,30,224]`; PyTorch models still accept batches.
- `*.metadata.json`: the shared model-metadata contract including vocabulary, provenance, evaluation, parity, runtime, review, and promotion gates.

Run tests with `uv run pytest`. The parity suite compares PyTorch model
probabilities with ONNX Runtime probabilities using absolute tolerance `1e-5`
and relative tolerance `1e-4`.
