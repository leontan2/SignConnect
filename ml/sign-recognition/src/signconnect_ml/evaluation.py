from __future__ import annotations

import json
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
        unknown_mask=np.asarray(dataset.unknown_mask, dtype=np.bool_),
        reject_indices=manifest.reject_indices,
    )


def metrics_document(
    metrics: ClassificationMetrics,
    manifest: DatasetManifest,
    split_name: str,
) -> dict:
    per_class = [
        {
            "index": index,
            "labelId": label,
            "precision": metrics.per_class_precision[index],
            "recall": metrics.per_class_recall[index],
            "f1": metrics.per_class_f1[index],
            "support": metrics.per_class_support[index],
        }
        for index, label in enumerate(manifest.classes)
    ]
    rejection = metrics.rejection
    return {
        "schemaVersion": 1,
        "datasetId": manifest.dataset_id,
        "manifestSha256": manifest.sha256,
        "provenanceStatus": manifest.provenance_status,
        "split": split_name,
        "metrics": {
            "accuracy": metrics.accuracy,
            "macroF1": metrics.macro_f1,
            "falseFinalRate": metrics.false_final_rate,
            "sampleCount": sum(metrics.per_class_support),
            "perClass": per_class,
            "confusionMatrix": {
                "labelOrder": list(manifest.classes),
                "rows": [list(row) for row in metrics.confusion_matrix],
            },
            "noSignBehavior": {
                "sampleCount": metrics.no_sign_count,
                "falseFinalCount": metrics.false_final_count,
                "falseFinalRate": metrics.false_final_rate,
            },
            "rejectionBehavior": {
                "minimumConfidence": rejection.minimum_confidence,
                "acceptedSignCount": rejection.accepted_sign_count,
                "lowConfidenceRejectionCount": rejection.low_confidence_rejection_count,
                "noSignDecisionCount": rejection.no_sign_decision_count,
                "rejectionRate": rejection.rejection_rate,
                "acceptedSignAccuracy": rejection.accepted_sign_accuracy,
                "unknownSampleCount": rejection.unknown_sample_count,
                "unknownRejectedCount": rejection.unknown_rejected_count,
                "unknownRejectionRate": rejection.unknown_rejection_rate,
                "unknownFalseFinalCount": rejection.unknown_false_final_count,
                "unknownFalseFinalRate": rejection.unknown_false_final_rate,
            },
        },
    }


def write_evaluation(path: str | Path, document: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
