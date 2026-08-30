from __future__ import annotations

import json
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from typing import Sequence

import numpy as np

from .constants import FEATURE_CONTRACT, FEATURE_COUNT, SCHEMA_VERSION, SEQUENCE_LENGTH


class PreprocessingError(ValueError):
    """Raised when normalized landmark input cannot form a safe gesture window."""


@dataclass(frozen=True)
class NormalizedLandmarkFrame:
    timestamp_ms: float
    features: Sequence[float]


def load_normalized_landmark_frames(path: Path) -> tuple[NormalizedLandmarkFrame, ...]:
    """Load the strict, derived-landmarks-only interchange document."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PreprocessingError("normalized landmark input is not readable JSON") from error

    if not isinstance(document, dict):
        raise PreprocessingError("normalized landmark input must be a JSON object")
    expected_root_fields = {"schemaVersion", "featureLayoutVersion", "frames"}
    if set(document) != expected_root_fields:
        raise PreprocessingError("normalized landmark input contains unsupported fields")
    if document["schemaVersion"] != SCHEMA_VERSION:
        raise PreprocessingError(f"schemaVersion must be {SCHEMA_VERSION}")
    if document["featureLayoutVersion"] != FEATURE_CONTRACT:
        raise PreprocessingError(f"featureLayoutVersion must be {FEATURE_CONTRACT}")
    if not isinstance(document["frames"], list):
        raise PreprocessingError("frames must be an array")

    frames: list[NormalizedLandmarkFrame] = []
    for frame_index, frame in enumerate(document["frames"]):
        if not isinstance(frame, dict) or set(frame) != {"timestampMs", "features"}:
            raise PreprocessingError(f"frame {frame_index} contains unsupported fields")
        frames.append(
            NormalizedLandmarkFrame(
                timestamp_ms=frame["timestampMs"],
                features=frame["features"],
            )
        )
    return tuple(frames)


def preprocess_file(
    input_path: Path,
    output_path: Path,
    *,
    maximum_frame_gap_ms: float = 200.0,
) -> Path:
    """Create one training-compatible NPZ without retaining input timestamps."""
    if output_path.suffix.lower() != ".npz":
        raise PreprocessingError("preprocessed output must use the .npz extension")
    window = resample_normalized_landmarks(
        load_normalized_landmark_frames(input_path),
        maximum_frame_gap_ms=maximum_frame_gap_ms,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output_path, features=window)
    return output_path


def resample_normalized_landmarks(
    frames: Sequence[NormalizedLandmarkFrame],
    *,
    maximum_frame_gap_ms: float = 200.0,
) -> np.ndarray:
    """Deterministically resample normalized frames to the model's fixed window."""
    if not frames:
        raise PreprocessingError("at least one normalized landmark frame is required")
    if not isfinite(maximum_frame_gap_ms) or maximum_frame_gap_ms <= 0:
        raise PreprocessingError("maximum_frame_gap_ms must be finite and positive")

    timestamps: list[float] = []
    feature_rows: list[np.ndarray] = []
    for frame_index, frame in enumerate(frames):
        if isinstance(frame.timestamp_ms, bool) or not isinstance(
            frame.timestamp_ms,
            (int, float, np.integer, np.floating),
        ):
            raise PreprocessingError(f"frame {frame_index} timestamp_ms must be a number")
        timestamp = float(frame.timestamp_ms)
        if not isfinite(timestamp) or timestamp < 0:
            raise PreprocessingError(f"frame {frame_index} timestamp_ms must be finite and non-negative")
        raw_values = np.asarray(frame.features)
        if raw_values.shape != (FEATURE_COUNT,):
            raise PreprocessingError(f"frame {frame_index} must contain exactly {FEATURE_COUNT} features")
        if raw_values.dtype.kind not in "iuf":
            raise PreprocessingError(f"frame {frame_index} features must be numbers")
        values = raw_values.astype(np.float64, copy=False)
        if not np.isfinite(values).all():
            raise PreprocessingError(f"frame {frame_index} features must be finite")
        presence = values[3::4]
        if not np.logical_or(presence == 0.0, presence == 1.0).all():
            raise PreprocessingError(f"frame {frame_index} presence values must be 0 or 1")
        landmarks = values.reshape(-1, 4)
        if np.any(landmarks[presence == 0.0, :3] != 0.0):
            raise PreprocessingError(f"frame {frame_index} missing landmarks must use zero coordinates")
        if timestamps and timestamp <= timestamps[-1]:
            raise PreprocessingError("frame timestamps must be strictly increasing")
        if timestamps and timestamp - timestamps[-1] > maximum_frame_gap_ms:
            raise PreprocessingError(f"frame gap exceeds {maximum_frame_gap_ms:g} ms")
        timestamps.append(timestamp)
        feature_rows.append(values)

    source = np.stack(feature_rows)
    if len(frames) == SEQUENCE_LENGTH:
        return source.astype(np.float32)
    if len(frames) == 1:
        return np.repeat(source.astype(np.float32), SEQUENCE_LENGTH, axis=0)

    targets = np.linspace(timestamps[0], timestamps[-1], SEQUENCE_LENGTH, dtype=np.float64)
    result = np.empty((SEQUENCE_LENGTH, FEATURE_COUNT), dtype=np.float64)
    right_index = 1
    for target_index, target_timestamp in enumerate(targets):
        while right_index < len(timestamps) - 1 and timestamps[right_index] < target_timestamp:
            right_index += 1
        left_index = right_index - 1
        left_timestamp = timestamps[left_index]
        right_timestamp = timestamps[right_index]
        ratio = (target_timestamp - left_timestamp) / (right_timestamp - left_timestamp)
        for landmark_offset in range(0, FEATURE_COUNT, 4):
            presence_index = landmark_offset + 3
            left_landmark = source[left_index, landmark_offset : landmark_offset + 4]
            right_landmark = source[right_index, landmark_offset : landmark_offset + 4]
            if left_landmark[3] == 1.0 and right_landmark[3] == 1.0:
                result[target_index, landmark_offset:presence_index] = (
                    left_landmark[:3] + ratio * (right_landmark[:3] - left_landmark[:3])
                )
                result[target_index, presence_index] = 1.0
            else:
                nearest = left_landmark if ratio <= 0.5 else right_landmark
                result[target_index, landmark_offset : landmark_offset + 4] = nearest

    return result.astype(np.float32)
