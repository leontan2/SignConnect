from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .manifest import DatasetManifest, ManifestError


@dataclass(frozen=True)
class SplitAssignment:
    manifest_sha256: str
    assignment_sha256: str
    seed: int
    train: tuple[str, ...]
    validation: tuple[str, ...]
    test: tuple[str, ...]

    def sample_ids(self, split: str) -> tuple[str, ...]:
        return getattr(self, split)


def create_signer_grouped_split(
    manifest: DatasetManifest,
    seed: int,
    fractions: tuple[float, float, float] | None = None,
) -> SplitAssignment:
    """Read the immutable signer-grouped assignments from the shared manifest.

    `fractions` remains accepted for config compatibility but cannot alter a
    locked authoritative manifest.
    """
    del fractions
    groups = {
        "TRAIN": tuple(sample.sample_id for sample in manifest.samples if sample.split_assignment == "TRAIN"),
        "VALIDATION": tuple(
            sample.sample_id for sample in manifest.samples if sample.split_assignment == "VALIDATION"
        ),
        "TEST": tuple(sample.sample_id for sample in manifest.samples if sample.split_assignment == "TEST"),
    }
    assignment = SplitAssignment(
        manifest_sha256=manifest.sha256,
        assignment_sha256=manifest.split_assignment_sha256,
        seed=seed,
        train=groups["TRAIN"],
        validation=groups["VALIDATION"],
        test=groups["TEST"],
    )
    validate_split(manifest, assignment)
    return assignment


def validate_split(manifest: DatasetManifest, split: SplitAssignment) -> None:
    if split.manifest_sha256 != manifest.sha256:
        raise ManifestError("split was created for a different manifest")
    if split.assignment_sha256 != manifest.split_assignment_sha256:
        raise ManifestError("split assignment digest differs from the locked manifest")
    expected = {
        "train": {sample.sample_id for sample in manifest.samples if sample.split_assignment == "TRAIN"},
        "validation": {
            sample.sample_id for sample in manifest.samples if sample.split_assignment == "VALIDATION"
        },
        "test": {sample.sample_id for sample in manifest.samples if sample.split_assignment == "TEST"},
    }
    actual = {name: set(split.sample_ids(name)) for name in expected}
    if actual != expected:
        raise ManifestError("split document must exactly preserve manifest assignments")

    signer_by_sample = {sample.sample_id: sample.signer_id for sample in manifest.samples}
    signer_groups = [
        {signer_by_sample[item] for item in actual[name]}
        for name in ("train", "validation", "test")
    ]
    if (
        signer_groups[0] & signer_groups[1]
        or signer_groups[0] & signer_groups[2]
        or signer_groups[1] & signer_groups[2]
    ):
        raise ManifestError("a signer appears in more than one split")


def split_document(split: SplitAssignment) -> dict:
    return {
        "schemaVersion": 1,
        "manifestSha256": split.manifest_sha256,
        "assignmentSha256": split.assignment_sha256,
        "seed": split.seed,
        "splits": {
            "train": list(split.train),
            "validation": list(split.validation),
            "test": list(split.test),
        },
    }


def split_sha256(split: SplitAssignment) -> str:
    encoded = json.dumps(split_document(split), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_split(path: str | Path, split: SplitAssignment) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(split_document(split), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def load_split(path: str | Path, manifest: DatasetManifest) -> SplitAssignment:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if document.get("schemaVersion") != 1 or not isinstance(document.get("splits"), dict):
        raise ManifestError("invalid split document")
    assignment = SplitAssignment(
        manifest_sha256=document.get("manifestSha256", ""),
        assignment_sha256=document.get("assignmentSha256", ""),
        seed=document.get("seed"),
        train=tuple(document["splits"].get("train", [])),
        validation=tuple(document["splits"].get("validation", [])),
        test=tuple(document["splits"].get("test", [])),
    )
    validate_split(manifest, assignment)
    return assignment
