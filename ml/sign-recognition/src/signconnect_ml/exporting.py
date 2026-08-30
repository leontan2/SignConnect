from __future__ import annotations

import hashlib
import json
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .constants import FEATURE_COUNT, SEQUENCE_LENGTH
from .contracts import validate_contract_document
from .manifest import ManifestError, load_manifest, require_genuine_sgsl
from .training import load_checkpoint_model

ONNX_OPSET = 18
ABSOLUTE_TOLERANCE = 1e-5
RELATIVE_TOLERANCE = 1e-4


def export_onnx(
    checkpoint_path: str | Path,
    manifest_path: str | Path,
    output_path: str | Path,
    claim_genuine_sgsl: bool = False,
    verify_parity: bool = False,
) -> tuple[Path, Path]:
    import torch

    manifest = load_manifest(manifest_path)
    if claim_genuine_sgsl:
        require_genuine_sgsl(manifest)
    model, checkpoint = load_checkpoint_model(checkpoint_path)
    if checkpoint["manifest_sha256"] != manifest.sha256:
        raise ManifestError("checkpoint and export manifest hashes differ")
    if tuple(checkpoint["classes"]) != manifest.classes:
        raise ManifestError("checkpoint and export vocabularies differ")
    probability_model = torch.nn.Sequential(model, torch.nn.Softmax(dim=-1))
    probability_model.eval()

    target = Path(output_path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    external_data_path = target.with_name(f"{target.name}.data")
    _remove_stale_external_data(external_data_path)
    example = torch.zeros((1, SEQUENCE_LENGTH, FEATURE_COUNT), dtype=torch.float32)
    with warnings.catch_warnings():
        # PyTorch 2.13's current dynamo exporter emits an internal pytree
        # FutureWarning while copying its graph. Keep suppression scoped to
        # dependency internals during this call; application warnings remain errors.
        warnings.simplefilter("ignore", FutureWarning)
        torch.onnx.export(
            probability_model,
            (example,),
            f=target,
            input_names=["features"],
            output_names=["probabilities"],
            opset_version=ONNX_OPSET,
            dynamo=True,
            external_data=False,
            optimize=True,
            verbose=False,
        )
    if external_data_path.exists():
        raise RuntimeError("ONNX export must be one self-contained file without external data")

    max_difference = (
        verify_onnx_parity(probability_model, target, seed=int(checkpoint["seed"]))
        if verify_parity
        else 0.0
    )
    metadata_path = target.with_suffix(".metadata.json")
    metadata = _metadata_document(
        probability_model,
        checkpoint,
        manifest,
        target,
        claim_genuine_sgsl,
        verify_parity,
        max_difference,
    )
    validate_contract_document(metadata, "model-metadata.schema.json")
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return target, metadata_path


def verify_onnx_parity(
    model,
    onnx_path: str | Path,
    seed: int = 20260830,
    absolute_tolerance: float = ABSOLUTE_TOLERANCE,
    relative_tolerance: float = RELATIVE_TOLERANCE,
) -> float:
    import onnxruntime as ort
    import torch

    inputs = np.random.default_rng(seed).normal(
        0.0, 0.25, size=(1, SEQUENCE_LENGTH, FEATURE_COUNT)
    ).astype(np.float32)
    with torch.no_grad():
        expected = model(torch.from_numpy(inputs)).cpu().numpy()
    session = ort.InferenceSession(str(Path(onnx_path)), providers=["CPUExecutionProvider"])
    actual = session.run(["probabilities"], {"features": inputs})[0]
    np.testing.assert_allclose(
        actual,
        expected,
        atol=absolute_tolerance,
        rtol=relative_tolerance,
    )
    return float(np.max(np.abs(actual - expected)))


def _metadata_document(
    model,
    checkpoint: dict,
    manifest,
    target: Path,
    genuine_sgsl: bool,
    parity_verified: bool,
    max_difference: float,
) -> dict:
    synthetic = manifest.synthetic
    architecture = checkpoint["architecture"].upper()
    blocking_reasons = [
        "SGSL-fluent Deaf review has not approved every sign label.",
        "Warmed ONNX Runtime Java CPU p95 latency has not been measured.",
    ]
    if synthetic:
        blocking_reasons.insert(0, "Synthetic fixtures are not genuine SGSL data.")
    elif not genuine_sgsl:
        blocking_reasons.insert(0, "Genuine SGSL provenance was not asserted from the attested manifest.")
    if not parity_verified:
        blocking_reasons.append("PyTorch to ONNX Runtime parity has not been verified.")
    evaluation = checkpoint["evaluation"]
    return {
        "schemaVersion": 1,
        "modelId": f"signconnect-{checkpoint['architecture']}-candidate",
        "modelVersion": "0.1.0-synthetic" if synthetic else "0.1.0-candidate",
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "mockModel": synthetic,
        "genuineSignLanguageData": genuine_sgsl,
        "targetLanguage": "sg-SG",
        "architecture": {
            "family": architecture,
            "name": f"SignConnect {architecture} sequence classifier",
            "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
        },
        "artifactSha256": _sha256_file(target),
        "input": {
            "name": "features",
            "shape": [1, 30, 224],
            "tensorType": "FLOAT32",
            "featureLayoutVersion": manifest.feature_layout_version,
            "normalizationVersion": "shoulder-midpoint-shoulder-width-v1",
            "featureOrder": [
                "LEFT_HAND_0_20_XYZ_PRESENCE",
                "RIGHT_HAND_0_20_XYZ_PRESENCE",
                "POSE_11_24_XYZ_PRESENCE",
            ],
        },
        "output": {
            "name": "probabilities",
            "shape": [1, len(manifest.classes)],
            "tensorType": "FLOAT32",
            "semanticsVersion": "softmax-class-probabilities-v1",
        },
        "decision": {"minimumConfidence": checkpoint["minimum_confidence"]},
        "labels": [
            {
                "index": index,
                "id": label,
                "captionText": None if label == "NO_SIGN" else _caption(label),
                "outcome": "NO_SIGN" if label == "NO_SIGN" else "SIGN",
            }
            for index, label in enumerate(manifest.classes)
        ],
        "trainingDataset": {
            "datasetId": manifest.dataset_id,
            "datasetVersion": manifest.dataset_version,
            "manifestPath": f"manifests/{manifest.dataset_id}.json",
            "manifestSha256": manifest.sha256,
            "licence": manifest.dataset_licence,
        },
        "evaluation": {
            "protocol": {
                "splitStrategy": "SYNTHETIC" if synthetic else "SIGNER_INDEPENDENT",
                "splitSha256": checkpoint["split_sha256"],
                "signerOverlapCount": 0,
                "testSignerCount": manifest.test_signer_count,
            },
            "metrics": {
                "macroF1": evaluation["macro_f1"],
                "accuracy": evaluation["accuracy"],
                "falseFinalRate": evaluation["false_final_rate"],
                "sampleCount": evaluation["sample_count"],
            },
        },
        "onnx": {
            "artifactPath": f"models/{target.name}",
            "opset": ONNX_OPSET,
            "parity": {
                "verified": parity_verified,
                "absoluteTolerance": ABSOLUTE_TOLERANCE,
                "relativeTolerance": RELATIVE_TOLERANCE,
                "maxAbsoluteDifference": max_difference,
            },
        },
        "runtime": {
            "engine": "ONNX_RUNTIME_JAVA",
            "minimumVersion": "1.23.2",
            "executionProviders": ["CPUExecutionProvider"],
            "maxBatchSize": 1,
            # Zero is the schema-defined unmeasured sentinel. APPROVED metadata
            # requires a positive, measured value at or below 500 ms.
            "warmedP95LatencyMs": 0.0,
        },
        "sgslReview": {
            "status": "PENDING",
            "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
            "reviewedLabelIds": [],
            "reviewArtifactSha256": None,
            "reviewedAt": None,
        },
        "governance": {
            "allTrainingSamplesConsentVerified": not synthetic,
            "usageRightsVerified": not synthetic,
            "signerIndependentEvaluationVerified": not synthetic,
            "rawVideoOrImageDataIncluded": False,
        },
        "productionPromotion": {
            "status": "BLOCKED",
            "assessedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "blockingReasons": blocking_reasons,
        },
    }


def _caption(label_id: str) -> str:
    return "No sign" if label_id == "NO_SIGN" else label_id.replace("_", " ").title()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _remove_stale_external_data(path: Path) -> None:
    if path.is_file():
        path.unlink()
    elif path.exists():
        raise RuntimeError(f"refusing to replace non-file external-data path: {path}")
