from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from signconnect_ml.cli import main
from signconnect_ml.constants import FEATURE_CONTRACT
from signconnect_ml.preprocessing import (
    NormalizedLandmarkFrame,
    PreprocessingError,
    preprocess_file,
    resample_normalized_landmarks,
)


def landmark_frame(
    timestamp_ms: float,
    x: float,
    *,
    present: bool = True,
) -> NormalizedLandmarkFrame:
    features = np.zeros(224, dtype=np.float32)
    features[0] = x
    features[3] = float(present)
    return NormalizedLandmarkFrame(timestamp_ms=timestamp_ms, features=features)


class PreprocessingTest(unittest.TestCase):
    def test_resamples_a_variable_length_sequence_to_exactly_thirty_frames(self) -> None:
        frames = [landmark_frame(0.0, 0.0), landmark_frame(29.0, 29.0)]

        first = resample_normalized_landmarks(frames)
        second = resample_normalized_landmarks(frames)

        self.assertEqual(first.shape, (30, 224))
        self.assertEqual(first.dtype, np.float32)
        np.testing.assert_array_equal(first, second)
        np.testing.assert_allclose(first[:, 0], np.arange(30, dtype=np.float32))
        np.testing.assert_array_equal(first[:, 3], np.ones(30, dtype=np.float32))

    def test_preserves_an_already_fixed_window_with_irregular_timing(self) -> None:
        frames = [landmark_frame(float(index**2), float(index)) for index in range(30)]

        window = resample_normalized_landmarks(frames)

        np.testing.assert_array_equal(window[:, 0], np.arange(30, dtype=np.float32))

    def test_rejects_timestamps_that_are_not_strictly_increasing(self) -> None:
        frames = [landmark_frame(10.0, 0.0), landmark_frame(10.0, 1.0)]

        with self.assertRaisesRegex(PreprocessingError, "strictly increasing"):
            resample_normalized_landmarks(frames)

    def test_rejects_a_discontinuous_sequence(self) -> None:
        frames = [landmark_frame(0.0, 0.0), landmark_frame(201.0, 1.0)]

        with self.assertRaisesRegex(PreprocessingError, "frame gap exceeds 200"):
            resample_normalized_landmarks(frames)

    def test_missing_landmarks_keep_binary_presence_during_resampling(self) -> None:
        frames = [
            landmark_frame(0.0, 5.0),
            landmark_frame(29.0, 0.0, present=False),
        ]

        window = resample_normalized_landmarks(frames)

        np.testing.assert_array_equal(window[:15, 3], np.ones(15, dtype=np.float32))
        np.testing.assert_array_equal(window[15:, 3], np.zeros(15, dtype=np.float32))
        np.testing.assert_array_equal(window[:15, 0], np.full(15, 5.0, dtype=np.float32))
        np.testing.assert_array_equal(window[15:, 0], np.zeros(15, dtype=np.float32))

    def test_rejects_non_binary_landmark_presence(self) -> None:
        invalid = landmark_frame(0.0, 0.0).features.copy()
        invalid[3] = 0.5

        with self.assertRaisesRegex(PreprocessingError, "presence values must be 0 or 1"):
            resample_normalized_landmarks([NormalizedLandmarkFrame(0.0, invalid)])

    def test_rejects_coordinates_for_a_missing_landmark(self) -> None:
        invalid = landmark_frame(0.0, 2.0, present=False)

        with self.assertRaisesRegex(PreprocessingError, "missing landmarks must use zero coordinates"):
            resample_normalized_landmarks([invalid])

    def test_rejects_a_non_numeric_timestamp(self) -> None:
        invalid = NormalizedLandmarkFrame("0", landmark_frame(0.0, 0.0).features)  # type: ignore[arg-type]

        with self.assertRaisesRegex(PreprocessingError, "timestamp_ms must be a number"):
            resample_normalized_landmarks([invalid])

    def test_cli_writes_only_the_fixed_feature_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "gesture.json"
            output_path = Path(directory) / "gesture.npz"
            input_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "featureLayoutVersion": FEATURE_CONTRACT,
                        "frames": [
                            {
                                "timestampMs": timestamp,
                                "features": landmark_frame(timestamp, timestamp).features.tolist(),
                            }
                            for timestamp in (0.0, 29.0)
                        ],
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                main(["preprocess", "--input", str(input_path), "--output", str(output_path)]),
                0,
            )

            with np.load(output_path, allow_pickle=False) as archive:
                self.assertEqual(archive.files, ["features"])
                self.assertEqual(archive["features"].shape, (30, 224))

    def test_file_boundary_rejects_raw_media_fields_without_writing_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "unsafe.json"
            output_path = Path(directory) / "gesture.npz"
            input_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "featureLayoutVersion": FEATURE_CONTRACT,
                        "frames": [],
                        "video": "raw-capture.mp4",
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(PreprocessingError, "unsupported fields"):
                preprocess_file(input_path, output_path)
            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()
