from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ClassificationMetrics:
    accuracy: float
    macro_f1: float
    per_class_f1: tuple[float, ...]
    false_final_rate: float
    false_final_count: int
    no_sign_count: int


def classification_metrics(
    logits: np.ndarray,
    targets: np.ndarray,
    no_sign_index: int,
    false_final_threshold: float,
) -> ClassificationMetrics:
    scores = np.asarray(logits, dtype=np.float64)
    expected = np.asarray(targets, dtype=np.int64)
    if scores.ndim != 2 or expected.ndim != 1 or scores.shape[0] != expected.shape[0]:
        raise ValueError("logits must be [samples, classes] and targets must be [samples]")
    if scores.shape[0] == 0 or not np.isfinite(scores).all():
        raise ValueError("metrics require non-empty finite logits")
    if not 0 <= no_sign_index < scores.shape[1]:
        raise ValueError("invalid NO_SIGN index")
    if not 0.0 <= false_final_threshold <= 1.0:
        raise ValueError("false-final threshold must be in [0,1]")

    shifted = scores - scores.max(axis=1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    predicted = probabilities.argmax(axis=1)
    confidence = probabilities.max(axis=1)

    f1_values = []
    for class_index in range(scores.shape[1]):
        true_positive = int(np.sum((predicted == class_index) & (expected == class_index)))
        false_positive = int(np.sum((predicted == class_index) & (expected != class_index)))
        false_negative = int(np.sum((predicted != class_index) & (expected == class_index)))
        denominator = 2 * true_positive + false_positive + false_negative
        f1_values.append(0.0 if denominator == 0 else (2 * true_positive) / denominator)

    no_sign_mask = expected == no_sign_index
    false_final = no_sign_mask & (predicted != no_sign_index) & (confidence >= false_final_threshold)
    no_sign_count = int(no_sign_mask.sum())
    false_final_count = int(false_final.sum())
    return ClassificationMetrics(
        accuracy=float(np.mean(predicted == expected)),
        macro_f1=float(np.mean(f1_values)),
        per_class_f1=tuple(float(value) for value in f1_values),
        false_final_rate=0.0 if no_sign_count == 0 else false_final_count / no_sign_count,
        false_final_count=false_final_count,
        no_sign_count=no_sign_count,
    )
