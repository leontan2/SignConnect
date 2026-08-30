from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .contracts import canonical_vocabulary_sha256, validate_contract_document


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TOP_LEVEL_FIELDS = {
    "schemaVersion",
    "fixtureId",
    "synthetic",
    "artifactPath",
    "artifactSha256",
    "metadataPath",
    "modelVersion",
    "vocabularyVersion",
    "vocabularySha256",
    "input",
    "absoluteTolerance",
    "vectors",
}
_INPUT_FIELDS = {
    "shape",
    "frames",
    "featuresPerFrame",
    "handLandmarkCount",
    "presenceOffset",
    "landmarkStride",
}
_VECTOR_FIELDS = {
    "id",
    "activeHandLandmarksPerFrame",
    "expectedProbabilities",
    "expectedDecision",
}
_DECISION_FIELDS = {
    "outcome",
    "wireLabelId",
    "wireCaptionText",
    "confidence",
}


class ParityError(ValueError):
    """Raised when a frozen cross-runtime parity assertion fails closed."""


@dataclass(frozen=True)
class ParityResult:
    vector_id: str
    probabilities: tuple[float, ...]
    outcome: str
    wire_label_id: str
    wire_caption_text: str | None
    confidence: float


def verify_runtime_parity(
    fixture_path: str | Path,
    repository_root: str | Path,
) -> tuple[ParityResult, ...]:
    """Verify frozen Python expectations against the bound ONNX artifact and decision rule."""
    import onnxruntime as ort

    root = Path(repository_root).resolve()
    fixture = _read_object(Path(fixture_path), "parity fixture")
    _require_exact_fields(fixture, _TOP_LEVEL_FIELDS, "parity fixture")
    if fixture["schemaVersion"] != 1 or fixture["synthetic"] is not True:
        raise ParityError("parity fixture identity is invalid")
    artifact_hash = _sha256(fixture.get("artifactSha256"), "artifact hash")
    vocabulary_hash = _sha256(fixture.get("vocabularySha256"), "vocabulary hash")
    artifact_path = _bound_file(root, fixture.get("artifactPath"), "artifact")
    metadata_path = _bound_file(root, fixture.get("metadataPath"), "metadata")
    if _sha256_file(artifact_path) != artifact_hash:
        raise ParityError("artifact hash does not match the frozen parity fixture")

    metadata = _read_object(metadata_path, "model metadata")
    validate_contract_document(metadata, "model-metadata.schema.json")
    if metadata.get("artifactSha256") != artifact_hash:
        raise ParityError("artifact hash does not match model metadata")
    if metadata.get("modelVersion") != fixture.get("modelVersion"):
        raise ParityError("model version does not match the frozen parity fixture")
    if metadata.get("vocabularyVersion") != fixture.get("vocabularyVersion"):
        raise ParityError("vocabulary version does not match the frozen parity fixture")
    if metadata.get("vocabularySha256") != vocabulary_hash:
        raise ParityError("vocabulary hash does not match model metadata")
    canonical_hash = canonical_vocabulary_sha256(
        metadata["targetLanguage"],
        metadata["vocabularyVersion"],
        metadata["labels"],
    )
    if canonical_hash != vocabulary_hash:
        raise ParityError("vocabulary hash does not match canonical runtime labels")

    input_spec = fixture.get("input")
    if not isinstance(input_spec, dict):
        raise ParityError("parity input specification is invalid")
    _require_exact_fields(input_spec, _INPUT_FIELDS, "parity input")
    shape = input_spec.get("shape")
    if shape != metadata.get("input", {}).get("shape") or shape != [1, 30, 224]:
        raise ParityError("parity input shape does not match model metadata")
    if (
        input_spec.get("frames") != 30
        or input_spec.get("featuresPerFrame") != 224
        or input_spec.get("handLandmarkCount") != 42
        or input_spec.get("presenceOffset") != 3
        or input_spec.get("landmarkStride") != 4
    ):
        raise ParityError("parity input construction is invalid")
    tolerance = fixture.get("absoluteTolerance")
    if not _finite_number(tolerance) or not 0.0 < float(tolerance) <= 1.0e-4:
        raise ParityError("parity tolerance is invalid")

    session = ort.InferenceSession(str(artifact_path), providers=["CPUExecutionProvider"])
    vectors = fixture.get("vectors")
    if not isinstance(vectors, list) or not vectors:
        raise ParityError("parity vectors are invalid")
    results = tuple(
        _verify_vector(session, metadata, input_spec, vector, float(tolerance))
        for vector in vectors
    )
    if len({result.vector_id for result in results}) != len(results):
        raise ParityError("parity vector identifiers must be unique")
    return results


def _verify_vector(session, metadata, input_spec, vector, tolerance: float) -> ParityResult:
    if not isinstance(vector, dict):
        raise ParityError("parity vector is invalid")
    _require_exact_fields(vector, _VECTOR_FIELDS, "parity vector")
    vector_id = vector.get("id")
    active_count = vector.get("activeHandLandmarksPerFrame")
    if not isinstance(vector_id, str) or not vector_id:
        raise ParityError("parity vector identifier is invalid")
    if (
        not isinstance(active_count, int)
        or isinstance(active_count, bool)
        or not 0 <= active_count <= input_spec["handLandmarkCount"]
    ):
        raise ParityError("parity active-hand count is invalid")
    expected = vector.get("expectedProbabilities")
    label_count = len(metadata["labels"])
    if (
        not isinstance(expected, list)
        or len(expected) != label_count
        or any(not _finite_number(value) for value in expected)
    ):
        raise ParityError("frozen probability vector is invalid")

    inputs = np.zeros(tuple(input_spec["shape"]), dtype=np.float32)
    for frame in range(input_spec["frames"]):
        for landmark in range(active_count):
            feature = (
                landmark * input_spec["landmarkStride"]
                + input_spec["presenceOffset"]
            )
            inputs[0, frame, feature] = 1.0
    actual = session.run(
        [metadata["output"]["name"]],
        {metadata["input"]["name"]: inputs},
    )[0]
    if actual.shape != (1, label_count):
        raise ParityError("ONNX probability shape does not match model metadata")
    actual_row = tuple(float(value) for value in actual[0])
    if any(not math.isfinite(value) for value in actual_row):
        raise ParityError("ONNX probabilities are non-finite")
    if not math.isclose(sum(actual_row), 1.0, abs_tol=tolerance, rel_tol=0.0):
        raise ParityError("ONNX probabilities are not normalized")
    if not np.allclose(actual_row, expected, atol=tolerance, rtol=0.0):
        raise ParityError(f"ONNX probabilities differ for vector {vector_id}")

    selected = max(range(label_count), key=actual_row.__getitem__)
    label = metadata["labels"][selected]
    confidence = actual_row[selected]
    decision = _decision(label, confidence, metadata["decision"]["minimumConfidence"])
    frozen_decision = vector.get("expectedDecision")
    if not isinstance(frozen_decision, dict):
        raise ParityError("frozen decision is invalid")
    _require_exact_fields(frozen_decision, _DECISION_FIELDS, "frozen decision")
    if (
        decision[:3]
        != (
            frozen_decision.get("outcome"),
            frozen_decision.get("wireLabelId"),
            frozen_decision.get("wireCaptionText"),
        )
        or not _finite_number(frozen_decision.get("confidence"))
        or not math.isclose(
            confidence,
            float(frozen_decision["confidence"]),
            abs_tol=tolerance,
            rel_tol=0.0,
        )
    ):
        raise ParityError(f"final decision differs for vector {vector_id}")
    return ParityResult(vector_id, actual_row, *decision, confidence)


def _decision(label: dict[str, Any], confidence: float, threshold: float):
    if label["outcome"] == "NO_SIGN":
        return "NO_SIGN", "NO_SIGN", None
    if label["outcome"] == "REJECT":
        return "REJECTED", "NO_SIGN", None
    if confidence < threshold:
        return "LOW_CONFIDENCE", "NO_SIGN", None
    return "RECOGNIZED", label["id"], label["captionText"]


def _bound_file(root: Path, value: Any, description: str) -> Path:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ParityError(f"{description} path is invalid")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise ParityError(f"{description} path is invalid")
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        raise ParityError(f"{description} path is unavailable")
    return path


def _read_object(path: Path, description: str) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as failure:
        raise ParityError(f"{description} is unavailable or invalid") from failure
    if not isinstance(document, dict):
        raise ParityError(f"{description} must be a JSON object")
    return document


def _require_exact_fields(document: dict[str, Any], fields: set[str], description: str) -> None:
    if set(document) != fields:
        raise ParityError(f"{description} fields are invalid")


def _sha256(value: Any, description: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise ParityError(f"{description} is invalid")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )
