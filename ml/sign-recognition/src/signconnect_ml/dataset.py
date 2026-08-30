from __future__ import annotations

from pathlib import Path
import hashlib

import numpy as np

from .constants import FEATURE_COUNT, SEQUENCE_LENGTH
from .manifest import DatasetManifest, ManifestError


class LandmarkDataset:
    def __init__(self, manifest: DatasetManifest, sample_ids: tuple[str, ...]) -> None:
        import torch

        self._torch = torch
        samples_by_id = {sample.sample_id: sample for sample in manifest.samples}
        self._samples = []
        for sample_id in sample_ids:
            if sample_id not in samples_by_id:
                raise ManifestError(f"split references unknown sample: {sample_id}")
            self._samples.append(samples_by_id[sample_id])
        self._manifest_dir = manifest.path.parent
        self._class_index = {label: index for index, label in enumerate(manifest.classes)}
        self._unknown_mask = tuple(
            manifest.label_outcome(sample.label_id) == "REJECT"
            for sample in self._samples
        )

    @property
    def unknown_mask(self) -> tuple[bool, ...]:
        return self._unknown_mask

    def __len__(self) -> int:
        return len(self._samples)

    def __getitem__(self, index: int):
        sample = self._samples[index]
        path = (self._manifest_dir / sample.path).resolve()
        try:
            path.relative_to(self._manifest_dir.resolve())
        except ValueError as exc:
            raise ManifestError("sample resolved outside manifest directory") from exc
        if _sha256_file(path) != sample.artifact_sha256:
            raise ManifestError(f"sample artifact digest mismatch: {sample.sample_id}")
        with np.load(path, allow_pickle=False) as archive:
            if set(archive.files) != {"features"}:
                raise ManifestError(f"sample archive must contain only features: {sample.sample_id}")
            features = np.asarray(archive["features"], dtype=np.float32)
        if features.shape != (SEQUENCE_LENGTH, FEATURE_COUNT):
            raise ManifestError(
                f"sample {sample.sample_id} must have shape {(SEQUENCE_LENGTH, FEATURE_COUNT)}"
            )
        if not np.isfinite(features).all():
            raise ManifestError(f"sample {sample.sample_id} contains non-finite features")
        return (
            self._torch.from_numpy(features.copy()),
            self._torch.tensor(self._class_index[sample.label_id], dtype=self._torch.long),
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
