from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import NO_SIGN, OUT_OF_VOCABULARY
from .contracts import (
    ContractError,
    canonical_vocabulary_sha256,
    validate_contract_document,
)


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
    handedness: str
    capture_condition: dict[str, str]


@dataclass(frozen=True)
class ReviewedLabel:
    label_id: str
    gloss: str
    caption_text: str


@dataclass(frozen=True)
class DatasetManifest:
    path: Path
    dataset_id: str
    dataset_version: str
    created_at: str
    purpose_version: str
    consent_notice_version: str
    vocabulary_version: str
    review_record_id: str
    reviewed_labels: tuple[ReviewedLabel, ...]
    retention_expires_at: str
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
    def reject_indices(self) -> tuple[int, ...]:
        return tuple(
            index
            for index, label_id in enumerate(self.classes)
            if label_id == OUT_OF_VOCABULARY
        )

    def label_outcome(self, label_id: str) -> str:
        if label_id == NO_SIGN:
            return "NO_SIGN"
        if label_id == OUT_OF_VOCABULARY:
            return "REJECT"
        return "SIGN"

    def caption_text(self, label_id: str) -> str | None:
        return next(
            (
                reviewed.caption_text
                for reviewed in self.reviewed_labels
                if reviewed.label_id == label_id
            ),
            None,
        )

    @property
    def runtime_labels(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            {
                "index": index,
                "id": label_id,
                "captionText": (
                    self.caption_text(label_id)
                    if self.label_outcome(label_id) == "SIGN"
                    else None
                ),
                "outcome": self.label_outcome(label_id),
            }
            for index, label_id in enumerate(self.classes)
        )

    @property
    def vocabulary_sha256(self) -> str:
        return canonical_vocabulary_sha256(
            self.target_language,
            self.vocabulary_version,
            self.runtime_labels,
        )

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
            handedness=raw["handedness"],
            capture_condition=dict(raw["captureCondition"]),
        )
        for raw in document["samples"]
    )
    observed_labels = {sample.label_id for sample in samples}
    if NO_SIGN not in observed_labels:
        raise ManifestError("dataset samples must explicitly include NO_SIGN")
    reviewed_labels = tuple(
        ReviewedLabel(
            label_id=raw["labelId"],
            gloss=raw["gloss"],
            caption_text=raw["captionText"],
        )
        for raw in document["reviewedLabels"]
    )
    classes = (
        NO_SIGN,
        *(label.label_id for label in reviewed_labels if label.label_id in observed_labels),
        *((OUT_OF_VOCABULARY,) if OUT_OF_VOCABULARY in observed_labels else ()),
    )
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return DatasetManifest(
        path=manifest_path,
        dataset_id=document["datasetId"],
        dataset_version=document["datasetVersion"],
        created_at=document["createdAt"],
        purpose_version=document["purposeVersion"],
        consent_notice_version=document["consentNoticeVersion"],
        vocabulary_version=document["vocabularyVersion"],
        review_record_id=document["reviewRecordId"],
        reviewed_labels=reviewed_labels,
        retention_expires_at=document["retentionExpiresAt"],
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
    if manifest.synthetic or manifest.target_language != "sls":
        raise ManifestError("Genuine SgSL provenance cannot be claimed by synthetic fixtures")


def require_training_authorization(manifest: DatasetManifest) -> None:
    if manifest.synthetic:
        return
    for sample in manifest.document["samples"]:
        if sample["consentAttestation"]["status"] != "VERIFIED":
            raise ManifestError("SgSL training requires verified consent for every sample")
        if sample["usageRightsAttestation"]["status"] != "VERIFIED":
            raise ManifestError("SgSL training requires verified usage rights for every sample")
        if sample["consentAttestation"]["withdrawalStatus"] != "ACTIVE":
            raise ManifestError("SgSL training requires active consent for every sample")
        permitted = set(sample["consentAttestation"]["permittedUses"])
        if not {"MODEL_TRAINING", "MODEL_EVALUATION"}.issubset(permitted):
            raise ManifestError("SgSL training and evaluation must both be permitted")
