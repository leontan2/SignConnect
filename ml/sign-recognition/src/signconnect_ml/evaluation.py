from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .dataset import LandmarkDataset
from .manifest import DatasetManifest
from .metrics import ClassificationMetrics, classification_metrics


def evaluate_model(
    model,
    dataset: LandmarkDataset,
    manifest: DatasetManifest,
    batch_size: int,
    false_final_threshold: float,
) -> ClassificationMetrics:
    import torch

    loader = torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    logits_parts = []
    targets_parts = []
    model.eval()
    with torch.no_grad():
        for features, targets in loader:
            logits_parts.append(model(features).cpu().numpy())
            targets_parts.append(targets.cpu().numpy())
    if not logits_parts:
        raise ValueError("cannot evaluate an empty dataset")
    return classification_metrics(
        np.concatenate(logits_parts),
        np.concatenate(targets_parts),
        manifest.no_sign_index,
        false_final_threshold,
    )


def metrics_document(
    metrics: ClassificationMetrics,
    manifest: DatasetManifest,
    split_name: str,
) -> dict:
    document = asdict(metrics)
    document["per_class_f1"] = {
        label: score for label, score in zip(manifest.classes, metrics.per_class_f1)
    }
    return {
        "schemaVersion": 1,
        "datasetId": manifest.dataset_id,
        "manifestSha256": manifest.sha256,
        "provenanceStatus": manifest.provenance_status,
        "split": split_name,
        "metrics": document,
    }


def write_evaluation(path: str | Path, document: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
