from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import numpy as np

from .constants import (
    FEATURE_CONTRACT,
    FEATURE_COUNT,
    NO_SIGN,
    PREPROCESSING_VERSION,
    SEQUENCE_LENGTH,
)
from .contracts import validate_contract_document

SYNTHETIC_CLASSES = (NO_SIGN, "SYNTHETIC_A", "SYNTHETIC_B")
FIXED_TIMESTAMP = "2026-08-30T00:00:00Z"


def generate_non_production_synthetic(
    output_dir: str | Path,
    seed: int = 20260830,
    signer_count: int = 6,
) -> Path:
    if signer_count < 3:
        raise ValueError("at least three synthetic signers are required")
    root = Path(output_dir).resolve()
    landmarks_dir = root / "landmarks"
    landmarks_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    signer_order = list(range(signer_count))
    random.Random(seed).shuffle(signer_order)
    validation_count = max(1, round(signer_count * 0.2))
    test_count = max(1, round(signer_count * 0.2))
    if validation_count + test_count >= signer_count:
        validation_count = test_count = 1
    train_count = signer_count - validation_count - test_count
    split_by_signer = {
        signer_index: (
            "TRAIN"
            if position < train_count
            else "VALIDATION"
            if position < train_count + validation_count
            else "TEST"
        )
        for position, signer_index in enumerate(signer_order)
    }
    samples = []

    for signer_index in range(signer_count):
        signer_hex = _stable_hex(f"signer:{seed}:{signer_index}", 16)
        signer_id = f"sgn_{signer_hex}"
        signer_bias = signer_index * 0.002
        for class_index, label_id in enumerate(SYNTHETIC_CLASSES):
            key = f"sample:{seed}:{signer_index}:{label_id}"
            sample_hex = _stable_hex(key, 24)
            sample_id = f"sample_{sample_hex}"
            features = rng.normal(
                loc=signer_bias,
                scale=0.01,
                size=(SEQUENCE_LENGTH, FEATURE_COUNT),
            ).astype(np.float32)
            if class_index > 0:
                start = (class_index - 1) * 16
                temporal = np.linspace(-1.0, 1.0, SEQUENCE_LENGTH, dtype=np.float32)
                features[:, start : start + 16] += temporal[:, None] * (0.5 * class_index)
            filename = f"{sample_id}.npz"
            artifact = landmarks_dir / filename
            np.savez_compressed(artifact, features=features)
            samples.append(
                {
                    "sampleId": sample_id,
                    "signerId": signer_id,
                    "labelId": label_id,
                    "language": "sls",
                    "handedness": "NOT_APPLICABLE",
                    "captureCondition": {
                        "lighting": "INDOOR",
                        "background": "PLAIN",
                        "cameraPosition": "DESKTOP",
                        "occlusion": "NONE",
                        "speed": "NATURAL",
                        "distance": "NOMINAL",
                        "scenario": "IDLE" if label_id == NO_SIGN else "ISOLATED_SIGN",
                    },
                    "captureTimestamp": FIXED_TIMESTAMP,
                    "landmarkArtifact": {
                        "path": f"landmarks/{filename}",
                        "sha256": _sha256_file(artifact),
                        "mediaType": "application/x-npz",
                    },
                    "frameCount": SEQUENCE_LENGTH,
                    "featureCount": FEATURE_COUNT,
                    "featureLayoutVersion": FEATURE_CONTRACT,
                    "consentAttestation": {
                        "status": "VERIFIED",
                        "attestationId": f"consent_{_stable_hex('consent:' + key, 24)}",
                        "consentedAt": FIXED_TIMESTAMP,
                        "permittedUses": ["MODEL_TRAINING", "MODEL_EVALUATION"],
                        "withdrawalStatus": "ACTIVE",
                    },
                    "usageRightsAttestation": {
                        "status": "VERIFIED",
                        "basis": "DATASET_LICENCE",
                        "sourceRecordId": f"rights_{_stable_hex('rights:' + key, 24)}",
                        "attestedAt": FIXED_TIMESTAMP,
                        "attestedByRole": "DATA_STEWARD",
                        "restrictions": ["NON-PRODUCTION synthetic pipeline testing only"],
                    },
                    "splitAssignment": split_by_signer[signer_index],
                }
            )

    assignment = [
        {
            "sampleId": sample["sampleId"],
            "signerId": sample["signerId"],
            "splitAssignment": sample["splitAssignment"],
        }
        for sample in sorted(samples, key=lambda item: item["sampleId"])
    ]
    assignment_sha256 = hashlib.sha256(
        json.dumps(assignment, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "datasetId": "non-production-synthetic-pipeline-fixture",
        "datasetVersion": "1.0.0-synthetic",
        "createdAt": FIXED_TIMESTAMP,
        "purposeVersion": "1.0.0-synthetic",
        "consentNoticeVersion": "1.0.0-synthetic",
        "vocabularyVersion": "1.0.0-synthetic",
        "reviewRecordId": f"review_{_stable_hex(f'review:{seed}', 24)}",
        "reviewedLabels": [
            {
                "labelId": "SYNTHETIC_A",
                "gloss": "SYNTHETIC-A",
                "captionText": "Synthetic A",
            },
            {
                "labelId": "SYNTHETIC_B",
                "gloss": "SYNTHETIC-B",
                "captionText": "Synthetic B",
            },
        ],
        "retentionExpiresAt": "2026-11-28T00:00:00Z",
        "provenance": {
            "kind": "NON_PRODUCTION_SYNTHETIC",
            "evidence": {
                "type": "SYNTHETIC_GENERATOR",
                "generatorId": "signconnect-ml-generate-synthetic",
                "generatorVersion": "1.0.0",
                "seed": seed,
            },
        },
        "targetLanguage": "sls",
        "featureLayoutVersion": FEATURE_CONTRACT,
        "preprocessingVersion": PREPROCESSING_VERSION,
        "datasetLicence": {
            "spdxExpression": "MIT",
            "commercialUseAllowed": False,
            "redistributionAllowed": False,
        },
        "splitPolicy": {
            "strategy": "SIGNER_INDEPENDENT",
            "locked": True,
            "assignmentSha256": assignment_sha256,
            "testSignerCount": len(
                {sample["signerId"] for sample in samples if sample["splitAssignment"] == "TEST"}
            ),
        },
        "samples": samples,
    }
    validate_contract_document(manifest, "dataset-manifest.schema.json")
    manifest_path = root / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def _stable_hex(value: str, length: int) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
