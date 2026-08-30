from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RejectionMetrics:
    minimum_confidence: float
    accepted_sign_count: int
    low_confidence_rejection_count: int
    no_sign_decision_count: int
    rejection_rate: float
    accepted_sign_accuracy: float | None
    unknown_sample_count: int
    unknown_rejected_count: int
    unknown_rejection_rate: float | None
    unknown_false_final_count: int
    unknown_false_final_rate: float | None


@dataclass(frozen=True)
class ClassificationMetrics:
    accuracy: float
    macro_f1: float
    per_class_precision: tuple[float, ...]
    per_class_recall: tuple[float, ...]
    per_class_f1: tuple[float, ...]
    per_class_support: tuple[int, ...]
    confusion_matrix: tuple[tuple[int, ...], ...]
    false_final_rate: float
    false_final_count: int
    no_sign_count: int
    rejection: RejectionMetrics


def classification_metrics(
    logits: np.ndarray,
    targets: np.ndarray,
    no_sign_index: int,
    false_final_threshold: float,
    unknown_mask: np.ndarray | None = None,
    reject_indices: tuple[int, ...] = (),
) -> ClassificationMetrics:
    scores = np.asarray(logits, dtype=np.float64)
    expected = np.asarray(targets, dtype=np.int64)
    if scores.ndim != 2 or expected.ndim != 1 or scores.shape[0] != expected.shape[0]:
        raise ValueError("logits must be [samples, classes] and targets must be [samples]")
    if scores.shape[0] == 0 or not np.isfinite(scores).all():
        raise ValueError("metrics require non-empty finite logits")
    if not 0 <= no_sign_index < scores.shape[1]:
        raise ValueError("invalid NO_SIGN index")
    if (
        type(reject_indices) is not tuple
        or len(reject_indices) != len(set(reject_indices))
        or any(type(index) is not int for index in reject_indices)
        or any(index < 0 or index >= scores.shape[1] for index in reject_indices)
        or no_sign_index in reject_indices
    ):
        raise ValueError("invalid reject class indices")
    if not 0.0 <= false_final_threshold <= 1.0:
        raise ValueError("false-final threshold must be in [0,1]")
    if np.any(expected < 0) or np.any(expected >= scores.shape[1]):
        raise ValueError("targets contain an invalid class index")

    if unknown_mask is None:
        unknown = np.zeros(expected.shape, dtype=np.bool_)
    else:
        unknown = np.asarray(unknown_mask)
        if unknown.dtype != np.bool_ or unknown.ndim != 1 or unknown.shape != expected.shape:
            raise ValueError("unknown mask must be a boolean [samples] array")
        non_sign_targets = np.isin(expected, (no_sign_index, *reject_indices))
        if np.any(unknown & ~non_sign_targets):
            raise ValueError("unknown mask samples must use a non-sign target")

    shifted = scores - scores.max(axis=1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    predicted = probabilities.argmax(axis=1)
    confidence = probabilities.max(axis=1)

    confusion = np.zeros((scores.shape[1], scores.shape[1]), dtype=np.int64)
    np.add.at(confusion, (expected, predicted), 1)

    precision_values = []
    recall_values = []
    f1_values = []
    support_values = []
    for class_index in range(scores.shape[1]):
        true_positive = int(np.sum((predicted == class_index) & (expected == class_index)))
        false_positive = int(np.sum((predicted == class_index) & (expected != class_index)))
        false_negative = int(np.sum((predicted != class_index) & (expected == class_index)))
        support = int(np.sum(expected == class_index))
        precision_values.append(
            0.0 if true_positive + false_positive == 0 else true_positive / (true_positive + false_positive)
        )
        recall_values.append(
            0.0 if true_positive + false_negative == 0 else true_positive / (true_positive + false_negative)
        )
        denominator = 2 * true_positive + false_positive + false_negative
        f1_values.append(0.0 if denominator == 0 else (2 * true_positive) / denominator)
        support_values.append(support)

    predicted_reject = np.isin(predicted, reject_indices)
    predicted_sign = (predicted != no_sign_index) & ~predicted_reject
    accepted_sign = predicted_sign & (confidence >= false_final_threshold)
    low_confidence_rejection = predicted_sign & ~accepted_sign
    # The frozen evidence contract partitions decisions into accepted signs,
    # confidence rejections, and non-sign decisions. Explicit REJECT labels are
    # non-sign outcomes and therefore belong to the last partition.
    no_sign_decision = (predicted == no_sign_index) | predicted_reject

    no_sign_mask = (expected == no_sign_index) & ~unknown
    false_final = no_sign_mask & accepted_sign
    no_sign_count = int(no_sign_mask.sum())
    false_final_count = int(false_final.sum())
    accepted_sign_count = int(accepted_sign.sum())
    low_confidence_rejection_count = int(low_confidence_rejection.sum())
    unknown_sample_count = int(unknown.sum())
    unknown_rejected_count = int(np.sum(unknown & ~accepted_sign))
    unknown_false_final_count = int(np.sum(unknown & accepted_sign))
    return ClassificationMetrics(
        accuracy=float(np.mean(predicted == expected)),
        macro_f1=float(np.mean(f1_values)),
        per_class_precision=tuple(float(value) for value in precision_values),
        per_class_recall=tuple(float(value) for value in recall_values),
        per_class_f1=tuple(float(value) for value in f1_values),
        per_class_support=tuple(support_values),
        confusion_matrix=tuple(tuple(int(value) for value in row) for row in confusion),
        false_final_rate=0.0 if no_sign_count == 0 else false_final_count / no_sign_count,
        false_final_count=false_final_count,
        no_sign_count=no_sign_count,
        rejection=RejectionMetrics(
            minimum_confidence=float(false_final_threshold),
            accepted_sign_count=accepted_sign_count,
            low_confidence_rejection_count=low_confidence_rejection_count,
            no_sign_decision_count=int(no_sign_decision.sum()),
            rejection_rate=low_confidence_rejection_count / scores.shape[0],
            accepted_sign_accuracy=(
                None
                if accepted_sign_count == 0
                else float(np.mean(predicted[accepted_sign] == expected[accepted_sign]))
            ),
            unknown_sample_count=unknown_sample_count,
            unknown_rejected_count=unknown_rejected_count,
            unknown_rejection_rate=(
                None if unknown_sample_count == 0 else unknown_rejected_count / unknown_sample_count
            ),
            unknown_false_final_count=unknown_false_final_count,
            unknown_false_final_rate=(
                None if unknown_sample_count == 0 else unknown_false_final_count / unknown_sample_count
            ),
        ),
    )
