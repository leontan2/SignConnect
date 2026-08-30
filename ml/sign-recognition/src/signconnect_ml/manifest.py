from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import NO_SIGN
from .contracts import ContractError, validate_contract_document


class ManifestError(ContractError):
    """Raised when a dataset manifest violates schema or ML semantic gates."""


@dataclass(frozen=True)
class Sample:
    sample_id: str
    path: str
    artifact_sha256: str
    label_id: str
    signer_id: str
    split_assignment: str


@dataclass(frozen=True)
class DatasetManifest:
    path: Path
    dataset_id: str
    dataset_version: str
    created_at: str
    provenance_status: str
    provenance_evidence: dict[str, Any]
    target_language: str
    feature_layout_version: str
    preprocessing_version: str
    dataset_licence: dict[str, Any]
    split_assignment_sha256: str
    test_signer_count: int
    classes: tuple[str, ...]
    samples: tuple[Sample, ...]
    document: dict[str, Any]
    canonical_json: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.canonical_json).hexdigest()

    @property
    def no_sign_index(self) -> int:
        return self.classes.index(NO_SIGN)

    @property
    def synthetic(self) -> bool:
        return self.provenance_status == "NON_PRODUCTION_SYNTHETIC"


def load_manifest(path: str | Path) -> DatasetManifest:
    manifest_path = Path(path).resolve()
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"Could not read manifest: {manifest_path}") from exc
    if not isinstance(document, dict):
        raise ManifestError("Manifest root must be an object")
    try:
        validate_contract_document(document, "dataset-manifest.schema.json")
    except ContractError as exc:
        raise ManifestError(str(exc)) from exc

    samples = tuple(
        Sample(
            sample_id=raw["sampleId"],
            path=raw["landmarkArtifact"]["path"],
            artifact_sha256=raw["landmarkArtifact"]["sha256"],
            label_id=raw["labelId"],
            signer_id=raw["signerId"],
            split_assignment=raw["splitAssignment"],
        )
        for raw in document["samples"]
    )
    observed_labels = {sample.label_id for sample in samples}
    if NO_SIGN not in observed_labels:
        raise ManifestError("dataset samples must explicitly include NO_SIGN")
    classes = (NO_SIGN, *sorted(observed_labels - {NO_SIGN}))
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return DatasetManifest(
        path=manifest_path,
        dataset_id=document["datasetId"],
        dataset_version=document["datasetVersion"],
        created_at=document["createdAt"],
        provenance_status=document["provenance"]["kind"],
        provenance_evidence=dict(document["provenance"]["evidence"]),
        target_language=document["targetLanguage"],
        feature_layout_version=document["featureLayoutVersion"],
        preprocessing_version=document["preprocessingVersion"],
        dataset_licence=dict(document["datasetLicence"]),
        split_assignment_sha256=document["splitPolicy"]["assignmentSha256"],
        test_signer_count=document["splitPolicy"]["testSignerCount"],
        classes=classes,
        samples=samples,
        document=document,
        canonical_json=canonical,
    )


def require_genuine_sgsl(manifest: DatasetManifest) -> None:
    if manifest.synthetic or manifest.target_language != "sg-SG":
        raise ManifestError("Genuine SgSL provenance cannot be claimed by synthetic fixtures")


def require_training_authorization(manifest: DatasetManifest) -> None:
    if manifest.synthetic:
        return
    for sample in manifest.document["samples"]:
        if sample["consentAttestation"]["status"] != "VERIFIED":
            raise ManifestError("SgSL training requires verified consent for every sample")
        if sample["usageRightsAttestation"]["status"] != "VERIFIED":
            raise ManifestError("SgSL training requires verified usage rights for every sample")
        permitted = set(sample["consentAttestation"]["permittedUses"])
        if not {"MODEL_TRAINING", "MODEL_EVALUATION"}.issubset(permitted):
            raise ManifestError("SgSL training and evaluation must both be permitted")
