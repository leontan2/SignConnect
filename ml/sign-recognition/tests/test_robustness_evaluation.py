from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import torch

from signconnect_ml.evaluation import evaluate_model, metrics_document


class _IndexedDataset:
    def __init__(self, targets: tuple[int, ...], samples: tuple[SimpleNamespace, ...]) -> None:
        self._targets = targets
        self._samples = samples
        self.unknown_mask = tuple(False for _ in targets)

    def __len__(self) -> int:
        return len(self._targets)

    def __getitem__(self, index: int):
        return torch.tensor([index], dtype=torch.long), torch.tensor(
            self._targets[index], dtype=torch.long
        )


class _IndexedLogits(torch.nn.Module):
    def __init__(self, logits: tuple[tuple[float, ...], ...]) -> None:
        super().__init__()
        self.register_buffer("_logits", torch.tensor(logits, dtype=torch.float32))

    def forward(self, indices):
        return self._logits[indices[:, 0]]


def _sample(
    sample_id: str,
    *,
    lighting: str,
    distance: str,
    speed: str,
    handedness: str,
    occlusion: str,
    scenario: str,
) -> SimpleNamespace:
    return SimpleNamespace(
        sample_id=sample_id,
        split_assignment="TEST",
        handedness=handedness,
        capture_condition={
            "lighting": lighting,
            "distance": distance,
            "speed": speed,
            "occlusion": occlusion,
            "scenario": scenario,
        },
    )


def _manifest(*, synthetic: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        classes=("NO_SIGN", "HELLO", "HELP"),
        dataset_id="locked-sgsl-fixture",
        sha256="a" * 64,
        provenance_status=(
            "NON_PRODUCTION_SYNTHETIC" if synthetic else "VERIFIED_GENUINE_SGSL"
        ),
        synthetic=synthetic,
        no_sign_index=0,
        reject_indices=(),
        document={"splitPolicy": {"locked": True}},
    )


def test_locked_test_report_adds_deterministic_support_counted_robustness_slices():
    samples = (
        _sample(
            "sample_a",
            lighting="LOW",
            distance="NEAR",
            speed="SLOW",
            handedness="LEFT",
            occlusion="NONE",
            scenario="ISOLATED_SIGN",
        ),
        _sample(
            "sample_b",
            lighting="DAYLIGHT",
            distance="FAR",
            speed="FAST",
            handedness="RIGHT",
            occlusion="PARTIAL",
            scenario="NATURAL_MOVEMENT",
        ),
        _sample(
            "sample_c",
            lighting="LOW",
            distance="NEAR",
            speed="SLOW",
            handedness="LEFT",
            occlusion="NONE",
            scenario="ISOLATED_SIGN",
        ),
    )
    dataset = _IndexedDataset((0, 1, 2), samples)
    model = _IndexedLogits(
        (
            (9.0, 0.0, 0.0),
            (0.0, 9.0, 0.0),
            (0.0, 9.0, 1.0),
        )
    )

    result = evaluate_model(
        model,
        dataset,
        _manifest(),
        batch_size=2,
        false_final_threshold=0.8,
    )
    report = metrics_document(result, _manifest(), "test")

    assert report["metrics"]["sampleCount"] == 3
    assert [item["support"] for item in report["metrics"]["perClass"]] == [1, 1, 1]
    assert list(report["metrics"]["robustnessSlices"]) == [
        "lighting",
        "cameraDistance",
        "signingSpeed",
        "handedness",
        "occlusion",
        "behaviorScenario",
    ]
    assert report["metrics"]["robustnessSlices"]["lighting"] == [
        {
            "value": "LOW",
            "support": 2,
            "accuracy": 0.5,
            "macroF1": pytest.approx(1 / 3),
            "falseFinalRate": 0.0,
            "rejectionRate": 0.0,
        },
        {
            "value": "DAYLIGHT",
            "support": 1,
            "accuracy": 1.0,
            "macroF1": pytest.approx(1 / 3),
            "falseFinalRate": 0.0,
            "rejectionRate": 0.0,
        },
    ]
    assert [
        item["value"]
        for item in report["metrics"]["robustnessSlices"]["behaviorScenario"]
    ] == ["ISOLATED_SIGN", "NATURAL_MOVEMENT"]

    serialized = json.dumps(report, sort_keys=True)
    assert "sample_a" not in serialized
    assert "sample_b" not in serialized
    assert "sample_c" not in serialized
    for forbidden_key in ("logits", "targets", "features", "tensor", "signerId", "sampleId"):
        assert f'"{forbidden_key}"' not in serialized


@pytest.mark.parametrize(
    ("field", "unknown_value"),
    (
        ("lighting", None),
        ("distance", "UNKNOWN"),
        ("speed", "UNKNOWN"),
        ("handedness", "UNKNOWN"),
        ("occlusion", "UNKNOWN"),
        ("scenario", None),
    ),
)
def test_genuine_locked_test_rejects_missing_or_unknown_slice_metadata(
    field: str, unknown_value: str | None
):
    sample = _sample(
        "sample_a",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="RIGHT",
        occlusion="NONE",
        scenario="UNKNOWN_GESTURE",
    )
    if field == "handedness":
        sample.handedness = unknown_value
    elif unknown_value is None:
        del sample.capture_condition[field]
    else:
        sample.capture_condition[field] = unknown_value

    with pytest.raises(ValueError, match="genuine locked-test samples require known"):
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0),)),
            _IndexedDataset((0,), (sample,)),
            _manifest(),
            batch_size=1,
            false_final_threshold=0.8,
        )


def test_evaluation_rejects_a_threshold_selected_on_the_test_split():
    sample = _sample(
        "sample_a",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="RIGHT",
        occlusion="NONE",
        scenario="ISOLATED_SIGN",
    )

    with pytest.raises(ValueError, match="threshold selection must not use the test split"):
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0),)),
            _IndexedDataset((0,), (sample,)),
            _manifest(),
            batch_size=1,
            false_final_threshold=0.8,
            threshold_selection_split="test",
        )


def test_non_test_evaluation_does_not_emit_robustness_slices():
    sample = _sample(
        "sample_a",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="RIGHT",
        occlusion="NONE",
        scenario="ISOLATED_SIGN",
    )
    sample.split_assignment = "VALIDATION"
    manifest = _manifest()

    report = metrics_document(
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0),)),
            _IndexedDataset((0,), (sample,)),
            manifest,
            batch_size=1,
            false_final_threshold=0.8,
        ),
        manifest,
        "validation",
    )

    assert "robustnessSlices" not in report["metrics"]


def test_robustness_slices_reject_mixed_or_unlocked_test_samples():
    test_sample = _sample(
        "sample_test",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="RIGHT",
        occlusion="NONE",
        scenario="ISOLATED_SIGN",
    )
    validation_sample = _sample(
        "sample_validation",
        lighting="DAYLIGHT",
        distance="FAR",
        speed="FAST",
        handedness="LEFT",
        occlusion="PARTIAL",
        scenario="NATURAL_MOVEMENT",
    )
    validation_sample.split_assignment = "VALIDATION"

    with pytest.raises(ValueError, match="only locked-test samples"):
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0), (0.0, 9.0, 0.0))),
            _IndexedDataset((0, 1), (test_sample, validation_sample)),
            _manifest(),
            batch_size=2,
            false_final_threshold=0.8,
        )

    unlocked_manifest = _manifest()
    unlocked_manifest.document["splitPolicy"]["locked"] = False
    with pytest.raises(ValueError, match="require a locked test split"):
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0),)),
            _IndexedDataset((0,), (test_sample,)),
            unlocked_manifest,
            batch_size=1,
            false_final_threshold=0.8,
        )


def test_synthetic_locked_test_keeps_explicit_unknown_handedness_compatible():
    sample = _sample(
        "sample_a",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="UNKNOWN",
        occlusion="NONE",
        scenario="UNKNOWN_GESTURE",
    )
    manifest = _manifest(synthetic=True)

    report = metrics_document(
        evaluate_model(
            _IndexedLogits(((9.0, 0.0, 0.0),)),
            _IndexedDataset((0,), (sample,)),
            manifest,
            batch_size=1,
            false_final_threshold=0.8,
        ),
        manifest,
        "test",
    )

    assert report["metrics"]["robustnessSlices"]["handedness"][0]["value"] == "UNKNOWN"


def test_locked_test_slices_cannot_be_relabelled_as_another_split():
    sample = _sample(
        "sample_a",
        lighting="INDOOR",
        distance="NOMINAL",
        speed="NATURAL",
        handedness="RIGHT",
        occlusion="NONE",
        scenario="ISOLATED_SIGN",
    )
    manifest = _manifest()
    result = evaluate_model(
        _IndexedLogits(((9.0, 0.0, 0.0),)),
        _IndexedDataset((0,), (sample,)),
        manifest,
        batch_size=1,
        false_final_threshold=0.8,
    )

    with pytest.raises(ValueError, match="locked-test robustness slices as test"):
        metrics_document(result, manifest, "validation")
