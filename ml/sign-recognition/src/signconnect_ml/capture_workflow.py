from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

import numpy as np


class CaptureWorkflowError(ValueError):
    """Raised when the offline capture workflow fails closed."""


@dataclass(frozen=True)
class CaptureAuthorization:
    governance_record_id: str
    governance_sha256: str
    governance_evidence_path: Path
    sgsl_review_record_id: str
    sgsl_review_sha256: str
    sgsl_review_evidence_path: Path
    consent_record_id: str
    consent_sha256: str
    consent_evidence_path: Path
    consented_at: str
    purpose_version: str
    consent_notice_version: str
    vocabulary_version: str
    retention_expires_at: str
    reviewed_label_ids: tuple[str, ...]


@dataclass(frozen=True)
class CaptureTake:
    sample_id: str
    label_id: str
    capture_timestamp: str
    handedness: str
    capture_condition: dict[str, str]
    landmarks: object


@dataclass(frozen=True)
class _AcceptedTake:
    sample_id: str
    label_id: str
    capture_timestamp: str
    handedness: str
    capture_condition: dict[str, str]
    landmarks: np.ndarray


@dataclass(frozen=True)
class CaptureExportReceipt:
    export_root: Path
    manifest_path: Path
    manifest_sha256: str
    sample_count: int


_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_EVIDENCE_ID = re.compile(r"^[a-z][a-z0-9_]{15,127}$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$")
_LABEL_ID = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
_EXPORT_ID = re.compile(r"^capture_[a-f0-9]{16,64}$")
_SIGNER_ID = re.compile(r"^sgn_[a-f0-9]{12,64}$")
_SAMPLE_ID = re.compile(r"^sample_[a-f0-9]{16,64}$")
_HANDEDNESS = {"LEFT", "RIGHT", "TWO_HANDED", "NOT_APPLICABLE", "UNKNOWN"}
_CAPTURE_CONDITION_VALUES = {
    "lighting": {"LOW", "INDOOR", "DAYLIGHT", "MIXED"},
    "background": {"PLAIN", "CLUTTERED", "MIXED"},
    "cameraPosition": {"DESKTOP", "LAPTOP", "MOBILE", "OTHER"},
    "occlusion": {"NONE", "PARTIAL"},
    "speed": {"SLOW", "NATURAL", "FAST"},
    "distance": {"NEAR", "NOMINAL", "FAR"},
    "scenario": {
        "ISOLATED_SIGN",
        "INCOMPLETE_GESTURE",
        "HELD_SIGN",
        "REPEATED_SIGN",
        "IDLE",
        "TRANSITION",
        "UNKNOWN_GESTURE",
        "NATURAL_MOVEMENT",
    },
}
_TIMESTAMP = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?Z$"
)


def _parse_utc(value: str, name: str) -> datetime:
    if _TIMESTAMP.fullmatch(value) is None:
        raise CaptureWorkflowError(f"invalid {name}")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as exc:
        raise CaptureWorkflowError(f"invalid {name}") from exc
    return parsed.astimezone(timezone.utc)


def _load_evidence_artifact(path: Path, expected_sha256: str, name: str) -> dict[str, object]:
    if not isinstance(path, Path) or not path.is_absolute():
        raise CaptureWorkflowError(f"invalid {name} evidence artifact")
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
            raise CaptureWorkflowError(f"invalid {name} evidence artifact")
        encoded = path.read_bytes()
    except OSError:
        raise CaptureWorkflowError(f"invalid {name} evidence artifact") from None
    if hashlib.sha256(encoded).hexdigest() != expected_sha256:
        raise CaptureWorkflowError(f"{name} evidence artifact digest mismatch")
    try:
        document = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CaptureWorkflowError(f"invalid {name} evidence artifact") from None
    if type(document) is not dict:
        raise CaptureWorkflowError(f"invalid {name} evidence artifact")
    return document


def _verify_evidence_artifacts(authorization: CaptureAuthorization) -> None:
    governance = _load_evidence_artifact(
        authorization.governance_evidence_path,
        authorization.governance_sha256,
        "governance",
    )
    if set(governance) != {
        "schemaVersion",
        "recordId",
        "status",
        "purposeVersion",
        "consentNoticeVersion",
        "vocabularyVersion",
        "retentionDays",
    } or governance != {
        "schemaVersion": 1,
        "recordId": authorization.governance_record_id,
        "status": "APPROVED",
        "purposeVersion": authorization.purpose_version,
        "consentNoticeVersion": authorization.consent_notice_version,
        "vocabularyVersion": authorization.vocabulary_version,
        "retentionDays": 90,
    }:
        raise CaptureWorkflowError("governance evidence artifact is not approved")

    review = _load_evidence_artifact(
        authorization.sgsl_review_evidence_path,
        authorization.sgsl_review_sha256,
        "SGSL review",
    )
    if set(review) != {
        "schemaVersion",
        "recordId",
        "status",
        "reviewerRole",
        "vocabularyVersion",
        "reviewedLabelIds",
    } or review != {
        "schemaVersion": 1,
        "recordId": authorization.sgsl_review_record_id,
        "status": "APPROVED",
        "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
        "vocabularyVersion": authorization.vocabulary_version,
        "reviewedLabelIds": list(authorization.reviewed_label_ids),
    }:
        raise CaptureWorkflowError("SGSL review evidence artifact is not approved")

    consent = _load_evidence_artifact(
        authorization.consent_evidence_path,
        authorization.consent_sha256,
        "participant consent",
    )
    if set(consent) != {
        "schemaVersion",
        "recordId",
        "status",
        "consentedAt",
        "purposeVersion",
        "consentNoticeVersion",
        "vocabularyVersion",
        "permittedUses",
        "withdrawalStatus",
        "retentionExpiresAt",
    } or consent != {
        "schemaVersion": 1,
        "recordId": authorization.consent_record_id,
        "status": "VERIFIED",
        "consentedAt": authorization.consented_at,
        "purposeVersion": authorization.purpose_version,
        "consentNoticeVersion": authorization.consent_notice_version,
        "vocabularyVersion": authorization.vocabulary_version,
        "permittedUses": ["MODEL_TRAINING", "MODEL_EVALUATION"],
        "withdrawalStatus": "ACTIVE",
        "retentionExpiresAt": authorization.retention_expires_at,
    }:
        raise CaptureWorkflowError(
            "participant consent evidence artifact is not active and verified"
        )


def _require_authorization(authorization: CaptureAuthorization | None) -> CaptureAuthorization:
    if authorization is None:
        raise CaptureWorkflowError("verified capture authorization artifacts are required")
    evidence_fields = (
        (authorization.governance_record_id, "governance evidence ID", _EVIDENCE_ID),
        (authorization.governance_sha256, "governance evidence digest", _DIGEST),
        (authorization.sgsl_review_record_id, "SGSL review evidence ID", _EVIDENCE_ID),
        (authorization.sgsl_review_sha256, "SGSL review evidence digest", _DIGEST),
        (authorization.consent_record_id, "participant consent evidence ID", _EVIDENCE_ID),
        (authorization.consent_sha256, "participant consent evidence digest", _DIGEST),
        (authorization.purpose_version, "purpose version", _VERSION),
        (authorization.consent_notice_version, "consent notice version", _VERSION),
        (authorization.vocabulary_version, "vocabulary version", _VERSION),
    )
    for value, name, pattern in evidence_fields:
        if pattern.fullmatch(value) is None:
            raise CaptureWorkflowError(f"invalid {name}")
    if not authorization.reviewed_label_ids or any(
        _LABEL_ID.fullmatch(label_id) is None
        for label_id in authorization.reviewed_label_ids
    ):
        raise CaptureWorkflowError("invalid reviewed label IDs")
    _verify_evidence_artifacts(authorization)
    return authorization


def _canonical_json(document: dict[str, object]) -> bytes:
    return (
        json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("utf-8")


def _deterministic_npz(landmarks: np.ndarray) -> bytes:
    array_buffer = BytesIO()
    np.save(array_buffer, landmarks.astype("<f4", copy=False), allow_pickle=False)
    archive_buffer = BytesIO()
    info = zipfile.ZipInfo("features.npy", date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = 0o600 << 16
    with zipfile.ZipFile(archive_buffer, mode="w") as archive:
        archive.writestr(info, array_buffer.getvalue())
    return archive_buffer.getvalue()


class CaptureWorkflow:
    """Development-only holder for explicitly accepted landmark takes."""

    def __init__(
        self,
        *,
        enabled: bool = False,
        private_root: Path | None = None,
        export_id: str | None = None,
        signer_id: str | None = None,
        authorization: CaptureAuthorization | None = None,
    ) -> None:
        if enabled:
            authorization = _require_authorization(authorization)
            if private_root is None:
                raise CaptureWorkflowError("an explicit private root is required")
            if not private_root.is_absolute():
                raise CaptureWorkflowError("private root must be absolute")
            if export_id is None or _EXPORT_ID.fullmatch(export_id) is None:
                raise CaptureWorkflowError("invalid export ID")
            if signer_id is None or _SIGNER_ID.fullmatch(signer_id) is None:
                raise CaptureWorkflowError("invalid pseudonymous signer ID")
        self._private_root = private_root.resolve() if private_root is not None else None
        self._export_id = export_id
        self._signer_id = signer_id
        self._authorization = authorization
        self._accepted: dict[str, _AcceptedTake] = {}
        self._state = "OPEN" if enabled else "DISABLED"

    @property
    def enabled(self) -> bool:
        return self._state == "OPEN"

    @property
    def pending_count(self) -> int:
        return len(self._accepted)

    def _require_open(self) -> None:
        if self._state == "CANCELLED":
            raise CaptureWorkflowError("capture workflow was cancelled")
        if self._state != "OPEN":
            raise CaptureWorkflowError("capture workflow is disabled")

    def accept(self, take: CaptureTake) -> str:
        self._require_open()
        if _SAMPLE_ID.fullmatch(take.sample_id) is None:
            raise CaptureWorkflowError("invalid pseudonymous sample ID")
        if take.sample_id in self._accepted:
            raise CaptureWorkflowError("duplicate sample ID")
        if (
            self._authorization is None
            or take.label_id not in self._authorization.reviewed_label_ids
        ):
            raise CaptureWorkflowError("label is not in the reviewed SGSL vocabulary")
        if take.handedness not in _HANDEDNESS:
            raise CaptureWorkflowError("invalid handedness")
        if (
            not isinstance(take.capture_condition, dict)
            or set(take.capture_condition) != set(_CAPTURE_CONDITION_VALUES)
            or any(
                take.capture_condition[name] not in allowed
                for name, allowed in _CAPTURE_CONDITION_VALUES.items()
            )
        ):
            raise CaptureWorkflowError("invalid capture condition")
        capture_time = _parse_utc(take.capture_timestamp, "capture timestamp")
        consent_time = _parse_utc(
            self._authorization.consented_at, "consent timestamp"
        )
        retention_expiry = _parse_utc(
            self._authorization.retention_expires_at, "retention expiry"
        )
        if consent_time > capture_time:
            raise CaptureWorkflowError("consent must precede capture")
        if retention_expiry <= capture_time:
            raise CaptureWorkflowError("retention expiry must follow capture")
        if retention_expiry > capture_time + timedelta(days=90):
            raise CaptureWorkflowError("retention expiry must be within 90 days")
        try:
            landmarks = np.asarray(take.landmarks, dtype=np.float64)
        except (TypeError, ValueError) as exc:
            raise CaptureWorkflowError("landmarks must be numeric") from exc
        if landmarks.shape != (30, 224) or not np.isfinite(landmarks).all():
            raise CaptureWorkflowError("landmarks must be finite [30,224]")
        copied = landmarks.astype(np.float32, copy=True)
        if not np.isfinite(copied).all():
            raise CaptureWorkflowError("landmarks must be finite float32 [30,224]")
        self._accepted[take.sample_id] = _AcceptedTake(
            sample_id=take.sample_id,
            label_id=take.label_id,
            capture_timestamp=take.capture_timestamp,
            handedness=take.handedness,
            capture_condition=dict(take.capture_condition),
            landmarks=copied,
        )
        return take.sample_id

    def discard(self, sample_id: str) -> bool:
        self._require_open()
        return self._accepted.pop(sample_id, None) is not None

    def cancel(self) -> None:
        if self._state == "CANCELLED":
            return
        if self._state == "OPEN":
            self._accepted.clear()
            self._state = "CANCELLED"

    def export(self) -> CaptureExportReceipt:
        self._require_open()
        if not self._accepted:
            raise CaptureWorkflowError("no accepted takes to export")
        if (
            self._private_root is None
            or self._export_id is None
            or self._signer_id is None
            or self._authorization is None
        ):
            raise CaptureWorkflowError("capture workflow is not fully authorized")

        authorization = _require_authorization(self._authorization)
        self._private_root.mkdir(parents=True, exist_ok=True)
        final_root = self._private_root / self._export_id
        if final_root.exists():
            raise CaptureWorkflowError("export destination already exists")
        staging_root = Path(
            tempfile.mkdtemp(prefix=f".{self._export_id}-", dir=self._private_root)
        )
        manifest_sha256 = ""
        sample_count = len(self._accepted)
        try:
            landmarks_root = staging_root / "landmarks"
            landmarks_root.mkdir()
            samples: list[dict[str, object]] = []
            for sample_id in sorted(self._accepted):
                accepted = self._accepted[sample_id]
                artifact_relative = Path("landmarks") / f"{sample_id}.npz"
                artifact_bytes = _deterministic_npz(accepted.landmarks)
                (staging_root / artifact_relative).write_bytes(artifact_bytes)
                samples.append(
                    {
                        "captureCondition": dict(accepted.capture_condition),
                        "captureTimestamp": accepted.capture_timestamp,
                        "featureCount": 224,
                        "featureLayoutVersion": "mediapipe-holistic-224-v1",
                        "frameCount": 30,
                        "handedness": accepted.handedness,
                        "labelId": accepted.label_id,
                        "landmarkArtifact": {
                            "mediaType": "application/x-npz",
                            "path": artifact_relative.as_posix(),
                            "sha256": hashlib.sha256(artifact_bytes).hexdigest(),
                        },
                        "language": "sls",
                        "sampleId": sample_id,
                        "signerId": self._signer_id,
                    }
                )
            manifest: dict[str, object] = {
                "authorization": {
                    "consentNoticeVersion": authorization.consent_notice_version,
                    "consentRecordId": authorization.consent_record_id,
                    "consentSha256": authorization.consent_sha256,
                    "governanceRecordId": authorization.governance_record_id,
                    "governanceSha256": authorization.governance_sha256,
                    "purposeVersion": authorization.purpose_version,
                    "sgslReviewRecordId": authorization.sgsl_review_record_id,
                    "sgslReviewSha256": authorization.sgsl_review_sha256,
                    "vocabularyVersion": authorization.vocabulary_version,
                },
                "exportId": self._export_id,
                "featureLayoutVersion": "mediapipe-holistic-224-v1",
                "fragmentType": "SIGNCONNECT_OFFLINE_CAPTURE",
                "preprocessingVersion": "shoulder-midpoint-shoulder-width-v1",
                "retentionExpiresAt": authorization.retention_expires_at,
                "samples": samples,
                "schemaVersion": 1,
                "targetLanguage": "sls",
            }
            manifest_bytes = _canonical_json(manifest)
            manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
            (staging_root / "manifest-fragment.json").write_bytes(manifest_bytes)
            staging_root.rename(final_root)
        except Exception:
            shutil.rmtree(staging_root, ignore_errors=True)
            raise

        self._accepted.clear()
        self._state = "EXPORTED"
        return CaptureExportReceipt(
            export_root=final_root,
            manifest_path=final_root / "manifest-fragment.json",
            manifest_sha256=manifest_sha256,
            sample_count=sample_count,
        )
