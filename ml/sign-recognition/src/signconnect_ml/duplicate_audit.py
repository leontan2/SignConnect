from __future__ import annotations

import hashlib
import math
import os
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping

import numpy as np

_ALLOWED_SPLITS = frozenset({"train", "validation", "test"})


class DuplicateAuditError(ValueError):
    """Raised when duplicate evidence cannot be audited safely."""


@dataclass(frozen=True)
class SampleIdentity:
    sample_id: str
    split: str
    signer_id: str


@dataclass(frozen=True)
class DuplicateFinding:
    kind: str
    left: SampleIdentity
    right: SampleIdentity
    similarity: float


@dataclass(frozen=True)
class SampleFingerprint:
    sample_id: str
    split: str
    signer_id: str
    tensor_sha256: str
    near_sha256: str


@dataclass(frozen=True)
class DuplicateAuditReport:
    status: str
    sample_count: int
    findings: tuple[DuplicateFinding, ...]
    fingerprints: tuple[SampleFingerprint, ...]


@dataclass(frozen=True)
class _LoadedSample:
    identity: SampleIdentity
    tensor_sha256: str
    near_sha256: str
    normalized: np.ndarray


def audit_duplicate_leakage(
    *,
    data_root: str | Path,
    samples: Iterable[object],
    near_duplicate_threshold: float = 0.9999,
) -> DuplicateAuditReport:
    if (
        not math.isfinite(near_duplicate_threshold)
        or near_duplicate_threshold < 0.0
        or near_duplicate_threshold > 1.0
    ):
        raise DuplicateAuditError("Near-duplicate threshold must be finite and between 0 and 1")
    root = Path(data_root)
    try:
        root_metadata = os.lstat(root)
    except OSError as exc:
        raise DuplicateAuditError("Duplicate audit data root is missing") from exc
    root_attributes = getattr(root_metadata, "st_file_attributes", 0)
    if stat.S_ISLNK(root_metadata.st_mode) or bool(
        root_attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    ):
        raise DuplicateAuditError("Duplicate audit data root cannot be a symbolic link")
    resolved_root = root.resolve()
    loaded: list[_LoadedSample] = []
    seen_sample_ids: set[str] = set()
    expected_shape: tuple[int, ...] | None = None
    for record in samples:
        try:
            if isinstance(record, Mapping):
                artifact = record["landmarkArtifact"]
                if not isinstance(artifact, Mapping):
                    raise TypeError("landmarkArtifact must be a mapping")
                sample_id = str(record["sampleId"])
                signer_id = str(record["signerId"])
                split = str(record["splitAssignment"])
                artifact_path = str(artifact["path"])
                declared_sha256 = str(artifact["sha256"])
            else:
                sample_id = str(getattr(record, "sample_id"))
                signer_id = str(getattr(record, "signer_id"))
                split = str(getattr(record, "split_assignment"))
                artifact_path = str(getattr(record, "path"))
                declared_sha256 = str(getattr(record, "artifact_sha256"))
        except (AttributeError, KeyError, TypeError) as exc:
            raise DuplicateAuditError("Duplicate audit received an invalid sample record") from exc
        if sample_id in seen_sample_ids:
            raise DuplicateAuditError(f"Duplicate audit found duplicate sample ID: {sample_id}")
        seen_sample_ids.add(sample_id)
        if split not in _ALLOWED_SPLITS:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: split must be train, validation, or test"
            )
        relative_path = Path(artifact_path)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: artifact is outside data root"
            )
        lexical_path = root
        for part in relative_path.parts:
            lexical_path = lexical_path / part
            try:
                metadata = os.lstat(lexical_path)
            except OSError:
                break
            reparse_attributes = getattr(metadata, "st_file_attributes", 0)
            if stat.S_ISLNK(metadata.st_mode) or bool(
                reparse_attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            ):
                raise DuplicateAuditError(
                    f"Duplicate audit rejected {sample_id}: symbolic links are not allowed"
                )
        path = (root / relative_path).resolve()
        try:
            path.relative_to(resolved_root)
        except ValueError as exc:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: artifact is outside data root"
            ) from exc
        if not path.is_file():
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: artifact is missing"
            )
        artifact_digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    artifact_digest.update(block)
        except OSError as exc:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: artifact is unreadable"
            ) from exc
        if artifact_digest.hexdigest() != declared_sha256.lower():
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: artifact digest mismatch"
            )
        try:
            with np.load(path, allow_pickle=False) as archive:
                if set(archive.files) != {"features"}:
                    raise DuplicateAuditError(
                        f"Duplicate audit rejected {sample_id}: invalid tensor archive"
                    )
                features = np.asarray(archive["features"], dtype="<f4")
        except DuplicateAuditError:
            raise
        except (OSError, ValueError, EOFError, KeyError, TypeError, zipfile.BadZipFile) as exc:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: invalid tensor archive"
            ) from exc
        if not np.isfinite(features).all():
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: non-finite features"
            )
        if expected_shape is None:
            expected_shape = features.shape
        elif features.shape != expected_shape:
            raise DuplicateAuditError(
                f"Duplicate audit rejected {sample_id}: inconsistent tensor shape"
            )
        digest = hashlib.sha256()
        digest.update(str(features.shape).encode("ascii"))
        digest.update(features.tobytes(order="C"))
        flattened = features.astype(np.float64, copy=False).reshape(-1)
        norm = float(np.linalg.norm(flattened))
        normalized = flattened / norm if norm else np.zeros_like(flattened)
        quantized = np.rint(normalized * 10_000).astype("<i4")
        near_digest = hashlib.sha256()
        near_digest.update(str(features.shape).encode("ascii"))
        near_digest.update(quantized.tobytes(order="C"))
        loaded.append(
            _LoadedSample(
                identity=SampleIdentity(
                    sample_id=sample_id,
                    split=split,
                    signer_id=signer_id,
                ),
                tensor_sha256=digest.hexdigest(),
                near_sha256=near_digest.hexdigest(),
                normalized=normalized,
            )
        )

    if not loaded:
        raise DuplicateAuditError("Duplicate audit requires at least one sample")
    loaded.sort(key=lambda sample: sample.identity.sample_id)
    findings: list[DuplicateFinding] = []
    for left_index, left in enumerate(loaded):
        for right in loaded[left_index + 1 :]:
            crosses_boundary = (
                left.identity.split != right.identity.split
                or left.identity.signer_id != right.identity.signer_id
            )
            exact = left.tensor_sha256 == right.tensor_sha256
            similarity = (
                1.0
                if exact
                else float(np.clip(np.dot(left.normalized, right.normalized), -1.0, 1.0))
            )
            if crosses_boundary and (exact or similarity >= near_duplicate_threshold):
                findings.append(
                    DuplicateFinding(
                        kind="EXACT_SHA256" if exact else "NEAR_DUPLICATE",
                        left=left.identity,
                        right=right.identity,
                        similarity=similarity,
                    )
                )
    return DuplicateAuditReport(
        status="BLOCKED" if findings else "PASS",
        sample_count=len(loaded),
        findings=tuple(findings),
        fingerprints=tuple(
            SampleFingerprint(
                sample_id=sample.identity.sample_id,
                split=sample.identity.split,
                signer_id=sample.identity.signer_id,
                tensor_sha256=sample.tensor_sha256,
                near_sha256=sample.near_sha256,
            )
            for sample in loaded
        ),
    )
