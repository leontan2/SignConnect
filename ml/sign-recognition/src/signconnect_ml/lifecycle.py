"""Safe lifecycle operations for explicitly indexed private dataset artifacts."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


class LifecycleError(ValueError):
    """Raised when lifecycle input would make artifact handling unsafe."""


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int
    sha256: str


@dataclass(frozen=True)
class ArtifactRecord:
    artifact_id: str
    kind: str
    relative_path: str
    resolved_path: Path
    signer_ids: tuple[str, ...]
    sample_ids: tuple[str, ...]
    retention_expires_at: datetime
    file_identity: FileIdentity | None


@dataclass(frozen=True)
class InventoryItem:
    artifact: ArtifactRecord
    exists: bool


@dataclass(frozen=True)
class InventoryReport:
    root: Path
    items: tuple[InventoryItem, ...]

    @property
    def artifact_ids(self) -> tuple[str, ...]:
        return tuple(item.artifact.artifact_id for item in self.items)

    @property
    def existing_count(self) -> int:
        return sum(item.exists for item in self.items)

    @property
    def missing_count(self) -> int:
        return len(self.items) - self.existing_count


@dataclass(frozen=True)
class ExpiryItem:
    artifact: ArtifactRecord
    expired: bool
    deletion_due_at: datetime
    deletion_overdue: bool


@dataclass(frozen=True)
class ExpiryReport:
    root: Path
    as_of: datetime
    items: tuple[ExpiryItem, ...]

    @property
    def expired_artifact_ids(self) -> tuple[str, ...]:
        return tuple(item.artifact.artifact_id for item in self.items if item.expired)

    @property
    def overdue_artifact_ids(self) -> tuple[str, ...]:
        return tuple(
            item.artifact.artifact_id for item in self.items if item.deletion_overdue
        )


@dataclass(frozen=True)
class DeletionPlan:
    root: Path
    reason: str
    planned_at: datetime
    requested_signer_ids: tuple[str, ...]
    requested_sample_ids: tuple[str, ...]
    artifacts: tuple[ArtifactRecord, ...]

    @property
    def artifact_ids(self) -> tuple[str, ...]:
        return tuple(artifact.artifact_id for artifact in self.artifacts)

    @property
    def dry_run(self) -> bool:
        return True


@dataclass(frozen=True)
class DeletionResult:
    root: Path
    reason: str
    executed_at: datetime
    deleted_artifact_ids: tuple[str, ...]
    missing_artifact_ids: tuple[str, ...]

    @property
    def dry_run(self) -> bool:
        return False


def execute_deletion(
    plan: DeletionPlan, *, confirm: bool = False
) -> DeletionResult:
    """Execute a deletion plan only after an explicit confirmation."""

    if confirm is not True:
        raise LifecycleError("deletion execution requires explicit confirmation")
    if not isinstance(plan, DeletionPlan):
        raise LifecycleError("execution requires a validated deletion plan")
    _validate_plan_scope(plan)

    root = _validate_root(plan.root)
    preflight: list[tuple[ArtifactRecord, Path, bool]] = []
    for artifact in plan.artifacts:
        resolved_path = _resolve_artifact_path(root, artifact.relative_path)
        if resolved_path != artifact.resolved_path:
            raise LifecycleError("deletion plan artifact path changed after planning")
        if resolved_path.is_symlink():
            raise LifecycleError("deletion execution refuses symbolic-link artifacts")
        exists = resolved_path.exists()
        if exists and not resolved_path.is_file():
            raise LifecycleError("deletion execution accepts indexed files only")
        if _file_identity(resolved_path) != artifact.file_identity:
            raise LifecycleError("deletion plan artifact changed after planning")
        preflight.append((artifact, resolved_path, exists))

    deleted: list[str] = []
    missing: list[str] = []
    for artifact, resolved_path, exists in preflight:
        if not exists:
            missing.append(artifact.artifact_id)
            continue
        try:
            resolved_path.unlink()
        except OSError as exc:
            raise LifecycleError(
                f"could not delete indexed artifact: {artifact.artifact_id}"
            ) from exc
        deleted.append(artifact.artifact_id)
    return DeletionResult(
        root=root,
        reason=plan.reason,
        executed_at=datetime.now(timezone.utc),
        deleted_artifact_ids=tuple(deleted),
        missing_artifact_ids=tuple(missing),
    )


def _validate_plan_scope(plan: DeletionPlan) -> None:
    requested_signers = _requested_ids(
        plan.requested_signer_ids,
        "requested_signer_ids",
    )
    requested_samples = _requested_ids(
        plan.requested_sample_ids,
        "requested_sample_ids",
    )
    if not requested_signers and not requested_samples:
        raise LifecycleError("execution requires a validated pseudonymous scope")
    if plan.reason not in {"WITHDRAWAL", "RETENTION_EXPIRED"}:
        raise LifecycleError("execution requires a validated deletion reason")
    _utc_datetime(plan.planned_at, "planned_at")
    if any(
        not (
            requested_signers.intersection(artifact.signer_ids)
            or requested_samples.intersection(artifact.sample_ids)
        )
        for artifact in plan.artifacts
    ):
        raise LifecycleError("plan contains an artifact outside its pseudonymous scope")


def inventory_artifacts(
    root: str | Path,
    artifact_index: Sequence[Mapping[str, Any]],
    *,
    signer_ids: Iterable[str] | None = None,
    sample_ids: Iterable[str] | None = None,
) -> InventoryReport:
    """Inventory exact indexed files, optionally selected by pseudonymous IDs."""

    resolved_root = _validate_root(root)
    requested_signers = _requested_ids(signer_ids, "signer_ids")
    requested_samples = _requested_ids(sample_ids, "sample_ids")
    records = _load_records(resolved_root, artifact_index)
    if requested_signers or requested_samples:
        records = tuple(
            record
            for record in records
            if requested_signers.intersection(record.signer_ids)
            or requested_samples.intersection(record.sample_ids)
        )
    items = tuple(
        InventoryItem(artifact=record, exists=record.file_identity is not None)
        for record in sorted(records, key=lambda candidate: candidate.artifact_id)
    )
    return InventoryReport(root=resolved_root, items=items)


def report_expiry(
    root: str | Path,
    artifact_index: Sequence[Mapping[str, Any]],
    *,
    as_of: datetime,
) -> ExpiryReport:
    """Report retention expiry and deletion deadlines without changing files."""

    current_time = _utc_datetime(as_of, "as_of")
    inventory = inventory_artifacts(root, artifact_index)
    items = tuple(
        ExpiryItem(
            artifact=item.artifact,
            expired=item.artifact.retention_expires_at <= current_time,
            deletion_due_at=item.artifact.retention_expires_at + timedelta(days=7),
            deletion_overdue=(
                item.artifact.retention_expires_at + timedelta(days=7) <= current_time
            ),
        )
        for item in inventory.items
    )
    return ExpiryReport(root=inventory.root, as_of=current_time, items=items)


def plan_deletion(
    root: str | Path,
    artifact_index: Sequence[Mapping[str, Any]],
    *,
    signer_ids: Iterable[str] | None = None,
    sample_ids: Iterable[str] | None = None,
    reason: str,
    planned_at: datetime | None = None,
) -> DeletionPlan:
    """Create a non-destructive plan for exact artifacts selected by random IDs."""

    requested_signers = _requested_ids(signer_ids, "signer_ids")
    requested_samples = _requested_ids(sample_ids, "sample_ids")
    if not requested_signers and not requested_samples:
        raise LifecycleError("deletion planning requires a signer ID or sample ID")
    if reason not in {"WITHDRAWAL", "RETENTION_EXPIRED"}:
        raise LifecycleError("reason must be WITHDRAWAL or RETENTION_EXPIRED")
    plan_time = _utc_datetime(
        planned_at or datetime.now(timezone.utc),
        "planned_at",
    )
    inventory = inventory_artifacts(
        root,
        artifact_index,
        signer_ids=requested_signers,
        sample_ids=requested_samples,
    )
    artifacts = tuple(item.artifact for item in inventory.items)
    if reason == "RETENTION_EXPIRED":
        expired_sources = tuple(
            artifact
            for artifact in artifacts
            if artifact.kind == "SOURCE" and artifact.retention_expires_at <= plan_time
        )
        affected_samples = {
            sample_id
            for artifact in expired_sources
            for sample_id in artifact.sample_ids
        }
        artifacts = tuple(
            artifact
            for artifact in artifacts
            if artifact.retention_expires_at <= plan_time
            or bool(affected_samples.intersection(artifact.sample_ids))
        )
    return DeletionPlan(
        root=inventory.root,
        reason=reason,
        planned_at=plan_time,
        requested_signer_ids=tuple(sorted(requested_signers)),
        requested_sample_ids=tuple(sorted(requested_samples)),
        artifacts=artifacts,
    )


def _validate_root(root: str | Path) -> Path:
    raw_root = Path(root)
    try:
        resolved = raw_root.resolve(strict=True)
    except OSError as exc:
        raise LifecycleError("dataset root must be an existing explicit directory") from exc
    if not resolved.is_dir() or resolved == Path(resolved.anchor):
        raise LifecycleError("dataset root must be an existing explicit directory")
    return resolved


def _requested_ids(values: Iterable[str] | None, field: str) -> frozenset[str]:
    if values is None:
        return frozenset()
    if isinstance(values, (str, bytes)):
        raise LifecycleError(f"{field} must be a collection of pseudonymous IDs")
    try:
        result = frozenset(values)
    except TypeError as exc:
        raise LifecycleError(f"{field} must be a collection of pseudonymous IDs") from exc
    if any(not isinstance(value, str) or not value.strip() for value in result):
        raise LifecycleError(f"{field} must contain non-empty pseudonymous IDs")
    return result


def _load_records(
    root: Path, artifact_index: Sequence[Mapping[str, Any]]
) -> tuple[ArtifactRecord, ...]:
    if isinstance(artifact_index, (str, bytes)):
        raise LifecycleError("artifact index must be a caller-supplied sequence of records")
    records: list[ArtifactRecord] = []
    seen_ids: set[str] = set()
    seen_paths: set[Path] = set()
    for raw in artifact_index:
        if not isinstance(raw, Mapping):
            raise LifecycleError("every artifact index entry must be an object")
        artifact_id = _required_text(raw, "artifactId")
        if artifact_id in seen_ids:
            raise LifecycleError(f"duplicate artifactId: {artifact_id}")
        seen_ids.add(artifact_id)
        kind = _required_text(raw, "kind")
        if kind not in {"SOURCE", "DERIVED", "CHECKPOINT"}:
            raise LifecycleError(f"unsupported artifact kind: {kind}")
        relative_path = _required_text(raw, "path")
        resolved_path = _resolve_artifact_path(root, relative_path)
        if resolved_path in seen_paths:
            raise LifecycleError("multiple artifact IDs resolve to the same resolved path")
        seen_paths.add(resolved_path)
        signer_ids = _index_ids(raw, "signerIds")
        sample_ids = _index_ids(raw, "sampleIds")
        if not signer_ids:
            raise LifecycleError(f"{kind} artifact {artifact_id} requires a signer ID")
        if not sample_ids:
            raise LifecycleError(f"{kind} artifact {artifact_id} requires a sample ID")
        records.append(
            ArtifactRecord(
                artifact_id=artifact_id,
                kind=kind,
                relative_path=relative_path,
                resolved_path=resolved_path,
                signer_ids=signer_ids,
                sample_ids=sample_ids,
                retention_expires_at=_parse_timestamp(
                    _required_text(raw, "retentionExpiresAt"),
                    "retentionExpiresAt",
                ),
                file_identity=_file_identity(resolved_path),
            )
        )
    return tuple(records)


def _required_text(raw: Mapping[str, Any], field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise LifecycleError(f"{field} must be a non-empty string")
    return value


def _index_ids(raw: Mapping[str, Any], field: str) -> tuple[str, ...]:
    values = raw.get(field)
    if not isinstance(values, list) or any(
        not isinstance(value, str) or not value.strip() for value in values
    ):
        raise LifecycleError(f"{field} must be a list of non-empty pseudonymous IDs")
    return tuple(sorted(set(values)))


def _resolve_artifact_path(root: Path, relative_path: str) -> Path:
    path = Path(relative_path)
    if (
        path.is_absolute()
        or ".." in path.parts
        or any(character in relative_path for character in "*?[]{}")
    ):
        raise LifecycleError("artifact paths must be exact relative file paths")
    candidate = root
    for part in path.parts:
        candidate /= part
        if candidate.is_symlink():
            raise LifecycleError("artifact paths must not contain symbolic-link components")
    resolved = (root / path).resolve(strict=False)
    if not resolved.is_relative_to(root) or resolved == root:
        raise LifecycleError("artifact path resolves outside the explicit dataset root")
    return resolved


def _parse_timestamp(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LifecycleError(f"{field} must be an ISO-8601 timestamp") from exc
    return _utc_datetime(parsed, field)


def _file_identity(path: Path) -> FileIdentity | None:
    if not path.is_file():
        return None
    try:
        before = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as artifact_file:
            for chunk in iter(lambda: artifact_file.read(1024 * 1024), b""):
                digest.update(chunk)
        after = path.stat()
    except OSError as exc:
        raise LifecycleError(f"could not inspect indexed artifact: {path.name}") from exc
    before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if before_identity != after_identity:
        raise LifecycleError(f"indexed artifact changed while inspected: {path.name}")
    return FileIdentity(
        device=after.st_dev,
        inode=after.st_ino,
        size=after.st_size,
        modified_ns=after.st_mtime_ns,
        sha256=digest.hexdigest(),
    )


def _utc_datetime(value: datetime, field: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise LifecycleError(f"{field} must include a UTC offset")
    return value.astimezone(timezone.utc)
