from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .dataset import LandmarkDataset
from .manifest import DatasetManifest
from .metrics import ClassificationMetrics, classification_metrics


_SLICE_DEFINITIONS = (
    ("lighting", "capture_condition", "lighting", ("LOW", "INDOOR", "DAYLIGHT", "MIXED")),
    ("cameraDistance", "capture_condition", "distance", ("NEAR", "NOMINAL", "FAR")),
    ("signingSpeed", "capture_condition", "speed", ("SLOW", "NATURAL", "FAST")),
    (
        "handedness",
        "attribute",
        "handedness",
        ("LEFT", "RIGHT", "TWO_HANDED", "NOT_APPLICABLE", "UNKNOWN"),
    ),
    ("occlusion", "capture_condition", "occlusion", ("NONE", "PARTIAL")),
    (
        "behaviorScenario",
        "capture_condition",
        "scenario",
        (
            "ISOLATED_SIGN",
            "INCOMPLETE_GESTURE",
            "HELD_SIGN",
            "REPEATED_SIGN",
            "IDLE",
            "TRANSITION",
            "UNKNOWN_GESTURE",
            "NATURAL_MOVEMENT",
        ),
    ),
)


@dataclass(frozen=True)
class RobustnessSlice:
    dimension: str
    value: str
    support: int
    accuracy: float
    macro_f1: float
    false_final_rate: float
    rejection_rate: float


@dataclass(frozen=True)
class EvaluationResult:
    aggregate: ClassificationMetrics
    robustness_slices: tuple[RobustnessSlice, ...]

    def __getattr__(self, name: str) -> Any:
        # Preserve the pre-slice evaluation surface for threshold selection and callers.
        return getattr(self.aggregate, name)


def evaluate_model(
    model,
    dataset: LandmarkDataset,
    manifest: DatasetManifest,
    batch_size: int,
    false_final_threshold: float,
    *,
    threshold_selection_split: str = "validation",
) -> EvaluationResult:
    import torch

    if threshold_selection_split == "test":
        raise ValueError("threshold selection must not use the test split")

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
    logits = np.concatenate(logits_parts)
    targets = np.concatenate(targets_parts)
    unknown_mask = np.asarray(dataset.unknown_mask, dtype=np.bool_)
    aggregate = classification_metrics(
        logits,
        targets,
        manifest.no_sign_index,
        false_final_threshold,
        unknown_mask=unknown_mask,
        reject_indices=manifest.reject_indices,
    )
    robustness_slices = _locked_test_robustness_slices(
        logits,
        targets,
        unknown_mask,
        dataset,
        manifest,
        false_final_threshold,
    )
    return EvaluationResult(aggregate=aggregate, robustness_slices=robustness_slices)


def metrics_document(
    metrics: ClassificationMetrics | EvaluationResult,
    manifest: DatasetManifest,
    split_name: str,
) -> dict:
    if (
        isinstance(metrics, EvaluationResult)
        and metrics.robustness_slices
        and split_name != "test"
    ):
        raise ValueError("report locked-test robustness slices as test")
    aggregate = metrics.aggregate if isinstance(metrics, EvaluationResult) else metrics
    per_class = [
        {
            "index": index,
            "labelId": label,
            "precision": aggregate.per_class_precision[index],
            "recall": aggregate.per_class_recall[index],
            "f1": aggregate.per_class_f1[index],
            "support": aggregate.per_class_support[index],
        }
        for index, label in enumerate(manifest.classes)
    ]
    rejection = aggregate.rejection
    metric_values = {
        "accuracy": aggregate.accuracy,
        "macroF1": aggregate.macro_f1,
        "falseFinalRate": aggregate.false_final_rate,
        "sampleCount": sum(aggregate.per_class_support),
        "perClass": per_class,
        "confusionMatrix": {
            "labelOrder": list(manifest.classes),
            "rows": [list(row) for row in aggregate.confusion_matrix],
        },
        "noSignBehavior": {
            "sampleCount": aggregate.no_sign_count,
            "falseFinalCount": aggregate.false_final_count,
            "falseFinalRate": aggregate.false_final_rate,
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
    }
    if isinstance(metrics, EvaluationResult) and metrics.robustness_slices:
        grouped = {definition[0]: [] for definition in _SLICE_DEFINITIONS}
        for item in metrics.robustness_slices:
            grouped[item.dimension].append(
                {
                    "value": item.value,
                    "support": item.support,
                    "accuracy": item.accuracy,
                    "macroF1": item.macro_f1,
                    "falseFinalRate": item.false_final_rate,
                    "rejectionRate": item.rejection_rate,
                }
            )
        metric_values["robustnessSlices"] = grouped
    return {
        "schemaVersion": 1,
        "datasetId": manifest.dataset_id,
        "manifestSha256": manifest.sha256,
        "provenanceStatus": manifest.provenance_status,
        "split": split_name,
        "metrics": metric_values,
    }


def _locked_test_robustness_slices(
    logits: np.ndarray,
    targets: np.ndarray,
    unknown_mask: np.ndarray,
    dataset: LandmarkDataset,
    manifest: DatasetManifest,
    false_final_threshold: float,
) -> tuple[RobustnessSlice, ...]:
    dataset_samples = getattr(dataset, "_samples", None)
    if dataset_samples is None:
        return ()
    samples = tuple(dataset_samples)
    if len(samples) != targets.shape[0]:
        raise ValueError("evaluation samples must align with model outputs")
    assignments = {sample.split_assignment for sample in samples}
    if "TEST" not in assignments:
        return ()
    if assignments != {"TEST"}:
        raise ValueError("robustness slices may use only locked-test samples")
    if manifest.document.get("splitPolicy", {}).get("locked") is not True:
        raise ValueError("robustness slices require a locked test split")

    slices: list[RobustnessSlice] = []
    for dimension, source, field, value_order in _SLICE_DEFINITIONS:
        observed = [
            (
                getattr(sample, field, None)
                if source == "attribute"
                else getattr(sample, "capture_condition", {}).get(field)
            )
            for sample in samples
        ]
        if not manifest.synthetic and any(
            item not in value_order or (dimension == "handedness" and item == "UNKNOWN")
            for item in observed
        ):
            raise ValueError(
                f"genuine locked-test samples require known {dimension} metadata"
            )
        for value in value_order:
            mask = np.asarray([item == value for item in observed], dtype=np.bool_)
            if not mask.any():
                continue
            slice_metrics = classification_metrics(
                logits[mask],
                targets[mask],
                manifest.no_sign_index,
                false_final_threshold,
                unknown_mask=unknown_mask[mask],
                reject_indices=manifest.reject_indices,
            )
            slices.append(
                RobustnessSlice(
                    dimension=dimension,
                    value=value,
                    support=int(mask.sum()),
                    accuracy=slice_metrics.accuracy,
                    macro_f1=slice_metrics.macro_f1,
                    false_final_rate=slice_metrics.false_final_rate,
                    rejection_rate=slice_metrics.rejection.rejection_rate,
                )
            )
    return tuple(slices)


def write_evaluation(path: str | Path, document: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
