import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ONNX_RUNTIME_AVAILABLE = importlib.util.find_spec("onnxruntime") is not None
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPOSITORY_ROOT
    / "contracts"
    / "sign-recognition-training"
    / "v1"
    / "parity"
    / "deterministic-sign-v1.synthetic.json"
)


@unittest.skipUnless(ONNX_RUNTIME_AVAILABLE, "ONNX Runtime is required")
class RuntimeParityTest(unittest.TestCase):
    def test_frozen_python_onnx_vectors_match_probabilities_and_final_decisions(self):
        from signconnect_ml.runtime_parity import verify_runtime_parity

        results = verify_runtime_parity(FIXTURE_PATH, REPOSITORY_ROOT)

        self.assertEqual(
            [
                ("pose-only-idle", "NO_SIGN", "NO_SIGN"),
                ("active-but-below-threshold", "LOW_CONFIDENCE", "NO_SIGN"),
                ("fully-active-synthetic-gesture", "RECOGNIZED", "MOCK_ACTIVE"),
            ],
            [
                (item.vector_id, item.outcome, item.wire_label_id)
                for item in results
            ],
        )

    def test_parity_fixture_fails_closed_on_artifact_or_vocabulary_hash_changes(self):
        from signconnect_ml.runtime_parity import ParityError, verify_runtime_parity

        original = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cases = {
            "artifact": ("artifactSha256", "0" * 64),
            "vocabulary": ("vocabularySha256", "1" * 64),
        }
        with tempfile.TemporaryDirectory() as temporary:
            for name, (field, value) in cases.items():
                with self.subTest(name=name):
                    changed = copy.deepcopy(original)
                    changed[field] = value
                    candidate = Path(temporary) / f"{name}.json"
                    candidate.write_text(json.dumps(changed), encoding="utf-8")

                    with self.assertRaisesRegex(ParityError, f"{name} hash"):
                        verify_runtime_parity(candidate, REPOSITORY_ROOT)


if __name__ == "__main__":
    unittest.main()
