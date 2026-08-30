import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def _write_checkpoint_marker(path: str) -> dict:
    Path(path).write_text("unsafe checkpoint executed", encoding="utf-8")
    return {}


class _ExecutableCheckpointPayload:
    def __init__(self, marker: Path) -> None:
        self.marker = marker

    def __reduce__(self):
        return _write_checkpoint_marker, (str(self.marker),)


def _string_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _string_values(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            yield from _string_values(child)


PIPELINE_AVAILABLE = all(
    importlib.util.find_spec(name) is not None
    for name in ("torch", "onnx", "onnxruntime", "onnxscript")
)


@unittest.skipUnless(PIPELINE_AVAILABLE, "PyTorch, ONNX, and ONNX Runtime are required")
class TrainingAndExportTest(unittest.TestCase):
    def test_model_state_digest_is_canonical_across_mapping_order(self):
        import torch

        from signconnect_ml.models import build_model
        from signconnect_ml.training import _state_dict_sha256

        model = build_model("tcn", class_count=2, hidden_size=8, dropout=0.1)
        state = model.state_dict()
        reversed_state = dict(reversed(list(state.items())))

        self.assertEqual(
            _state_dict_sha256(state, torch),
            _state_dict_sha256(reversed_state, torch),
        )
        changed = dict(state)
        first_name = next(iter(changed))
        changed[first_name] = changed[first_name] + 0.25
        self.assertNotEqual(
            _state_dict_sha256(state, torch),
            _state_dict_sha256(changed, torch),
        )

    def test_checkpoint_loader_blocks_pickle_code_execution(self):
        import torch

        from signconnect_ml.training import load_checkpoint_model

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "must-not-exist.txt"
            checkpoint = root / "untrusted.pt"
            torch.save(_ExecutableCheckpointPayload(marker), checkpoint)

            with self.assertRaisesRegex(ValueError, "checkpoint could not be loaded safely"):
                load_checkpoint_model(checkpoint)

            self.assertFalse(marker.exists())

    def test_checkpoint_loader_strictly_rejects_invalid_existing_format_fields(self):
        import torch

        from signconnect_ml.models import build_model
        from signconnect_ml.training import load_checkpoint_model

        model = build_model("tcn", class_count=2, hidden_size=8, dropout=0.1)
        valid = {
            "schema_version": 1,
            "state_dict": model.state_dict(),
            "architecture": "tcn",
            "hidden_size": 8,
            "dropout": 0.1,
            "classes": ["NO_SIGN", "HELLO"],
            "seed": 7,
            "manifest_sha256": "1" * 64,
            "dataset_id": "non-production-synthetic-security",
            "provenance_status": "NON_PRODUCTION_SYNTHETIC",
            "history": [
                {
                    "epoch": 1,
                    "trainingLoss": 0.5,
                    "validationMacroF1": 0.5,
                    "validationFalseFinalRate": 0.0,
                }
            ],
            "selected_epoch": 1,
            "evaluation_split": "test",
            "evaluation": {
                "macro_f1": 0.5,
                "accuracy": 0.5,
                "false_final_rate": 0.0,
                "sample_count": 2,
            },
            "split_sha256": "2" * 64,
            "test_signer_count": 1,
            "minimum_confidence": 0.8,
            "config": {
                "seed": 7,
                "model": "tcn",
                "epochs": 1,
                "batch_size": 2,
                "learning_rate": 0.001,
                "hidden_size": 8,
                "dropout": 0.1,
                "false_final_threshold": 0.8,
            },
        }

        cases = {
            "boolean hidden size": lambda item: item.__setitem__("hidden_size", True),
            "non-finite dropout": lambda item: item.__setitem__("dropout", float("nan")),
            "tuple vocabulary": lambda item: item.__setitem__("classes", ("NO_SIGN", "HELLO")),
            "nested vocabulary value": lambda item: item.__setitem__(
                "classes", ["NO_SIGN", ["private"]]
            ),
            "negative seed": lambda item: item.__setitem__("seed", -1),
            "invalid digest": lambda item: item.__setitem__("manifest_sha256", "private/path"),
            "out-of-range metric": lambda item: item["evaluation"].__setitem__("macro_f1", 1.1),
            "boolean sample count": lambda item: item["evaluation"].__setitem__("sample_count", True),
            "zero learning rate": lambda item: item["config"].__setitem__("learning_rate", 0.0),
            "legacy host path field": lambda item: item["config"].__setitem__(
                "manifest", "C:/private/training/manifest.json"
            ),
            "non-string config model": lambda item: item["config"].__setitem__(
                "model", ["private"]
            ),
            "non-string provenance": lambda item: item.__setitem__(
                "provenance_status", ["private"]
            ),
            "unexpected field": lambda item: item.__setitem__("private_path", "do-not-log"),
            "non-finite tensor": lambda item: item["state_dict"][
                next(iter(item["state_dict"]))
            ].fill_(float("nan")),
        }

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, mutate in cases.items():
                with self.subTest(case=name):
                    invalid = copy.deepcopy(valid)
                    mutate(invalid)
                    path = root / f"invalid-{len(name)}.pt"
                    torch.save(invalid, path)
                    with self.assertRaises(ValueError) as raised:
                        load_checkpoint_model(path)
                    self.assertEqual(
                        "checkpoint does not satisfy the SignConnect model contract",
                        str(raised.exception),
                    )

    def test_training_restores_the_earliest_best_validation_checkpoint(self):
        import torch

        from signconnect_ml.config import TrainConfig
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate_non_production_synthetic(root / "fixture", signer_count=6)

            def run(output: Path, epochs: int) -> dict:
                checkpoint = train(
                    TrainConfig(
                        seed=7,
                        model="tcn",
                        manifest=manifest,
                        output_dir=output,
                        epochs=epochs,
                        batch_size=6,
                        learning_rate=0.02,
                        hidden_size=8,
                        dropout=0.0,
                        false_final_threshold=0.8,
                    )
                )
                return torch.load(checkpoint, map_location="cpu", weights_only=True)

            first_epoch = run(root / "one-epoch", 1)
            selected = run(root / "four-epochs", 4)

            self.assertEqual(
                [first_epoch["history"][0]["validationMacroF1"]] * 4,
                [entry["validationMacroF1"] for entry in selected["history"]],
            )
            self.assertEqual(1, selected["selected_epoch"])
            for name, expected in first_epoch["state_dict"].items():
                self.assertTrue(torch.equal(expected, selected["state_dict"][name]), name)

    def test_locked_final_test_evaluation_is_explicit_and_one_shot(self):
        import torch

        from signconnect_ml.config import TrainConfig
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import evaluate_checkpoint, load_checkpoint_model, train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate_non_production_synthetic(root / "fixture", signer_count=6)
            output = root / "run"
            checkpoint = train(
                TrainConfig(
                    seed=7,
                    model="tcn",
                    manifest=manifest,
                    output_dir=output,
                    epochs=1,
                    batch_size=6,
                    learning_rate=0.002,
                    hidden_size=8,
                    dropout=0.0,
                    false_final_threshold=0.8,
                )
            )

            candidate = torch.load(checkpoint, map_location="cpu", weights_only=True)
            self.assertEqual("validation", candidate["evaluation_split"])
            with self.assertRaisesRegex(ValueError, "final-test evaluation has not been completed"):
                load_checkpoint_model(checkpoint)

            final_report = output / "final-test.json"
            self.assertEqual(
                final_report,
                evaluate_checkpoint(
                    checkpoint,
                    manifest,
                    output / "split.json",
                    final_report,
                    split_name="test",
                    batch_size=6,
                    false_final_threshold=0.8,
                ),
            )
            self.assertEqual(
                "test",
                json.loads(final_report.read_text(encoding="utf-8"))["split"],
            )
            finalized = torch.load(checkpoint, map_location="cpu", weights_only=True)
            self.assertEqual("test", finalized["evaluation_split"])
            load_checkpoint_model(checkpoint)

            second_report = output / "must-not-exist.json"
            with self.assertRaisesRegex(ValueError, "already been evaluated"):
                evaluate_checkpoint(
                    checkpoint,
                    manifest,
                    output / "split.json",
                    second_report,
                    split_name="test",
                    batch_size=6,
                    false_final_threshold=0.8,
                )
            self.assertFalse(second_report.exists())

    def test_final_test_uses_the_checkpoint_split_and_confidence_threshold(self):
        from signconnect_ml.config import TrainConfig
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import evaluate_checkpoint, train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate_non_production_synthetic(root / "fixture", signer_count=6)
            output = root / "run"
            checkpoint = train(
                TrainConfig(
                    seed=7,
                    model="tcn",
                    manifest=manifest,
                    output_dir=output,
                    epochs=1,
                    batch_size=6,
                    learning_rate=0.002,
                    hidden_size=8,
                    dropout=0.0,
                    false_final_threshold=0.8,
                )
            )

            locked_split = output / "split.json"
            changed_split = output / "changed-split.json"
            changed_document = json.loads(locked_split.read_text(encoding="utf-8"))
            changed_document["seed"] = 8
            changed_split.write_text(json.dumps(changed_document), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "locked checkpoint split"):
                evaluate_checkpoint(
                    checkpoint,
                    manifest,
                    changed_split,
                    output / "changed-split-result.json",
                    split_name="test",
                    batch_size=6,
                    false_final_threshold=0.8,
                )
            with self.assertRaisesRegex(ValueError, "locked confidence threshold"):
                evaluate_checkpoint(
                    checkpoint,
                    manifest,
                    locked_split,
                    output / "changed-threshold-result.json",
                    split_name="test",
                    batch_size=6,
                    false_final_threshold=0.7,
                )

    def test_tiny_training_export_is_non_production_and_has_runtime_parity(self):
        import numpy as np
        import onnxruntime as ort
        import torch

        from signconnect_ml.config import TrainConfig
        from signconnect_ml.contracts import validate_contract_document
        from signconnect_ml.exporting import export_onnx
        from signconnect_ml.manifest import ManifestError, load_manifest
        from signconnect_ml.splits import load_split, split_sha256
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import evaluate_checkpoint, train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate_non_production_synthetic(root / "fixture", signer_count=6)
            output = root / "run"
            checkpoint = train(
                TrainConfig(
                    seed=7,
                    model="tcn",
                    manifest=manifest,
                    output_dir=output,
                    epochs=1,
                    batch_size=6,
                    learning_rate=0.002,
                    hidden_size=8,
                    dropout=0.0,
                    false_final_threshold=0.8,
                )
            )
            saved_checkpoint = torch.load(checkpoint, map_location="cpu", weights_only=True)
            loaded_manifest = load_manifest(manifest)
            loaded_split = load_split(output / "split.json", loaded_manifest)
            self.assertEqual(
                {
                    "seed",
                    "model",
                    "epochs",
                    "batch_size",
                    "learning_rate",
                    "hidden_size",
                    "dropout",
                    "false_final_threshold",
                },
                set(saved_checkpoint["config"]),
            )
            self.assertEqual("non-production-synthetic-pipeline-fixture", saved_checkpoint["dataset_id"])
            self.assertEqual(loaded_manifest.sha256, saved_checkpoint["manifest_sha256"])
            self.assertEqual(split_sha256(loaded_split), saved_checkpoint["split_sha256"])
            self.assertNotIn(str(root.resolve()), set(_string_values(saved_checkpoint)))
            evaluate_checkpoint(
                checkpoint,
                manifest,
                output / "split.json",
                output / "final-test.json",
                split_name="test",
                batch_size=6,
                false_final_threshold=0.8,
            )
            requested_onnx = root / "artifact" / "sign-smoke.onnx"
            stale_external_data = requested_onnx.with_name(f"{requested_onnx.name}.data")
            stale_external_data.parent.mkdir(parents=True, exist_ok=True)
            stale_external_data.write_bytes(b"stale external weights")
            onnx_path, metadata_path = export_onnx(
                checkpoint,
                manifest,
                requested_onnx,
                verify_parity=True,
            )
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

            self.assertTrue(onnx_path.is_file())
            self.assertFalse(stale_external_data.exists())
            validate_contract_document(metadata, "model-metadata.schema.json")
            self.assertEqual("BLOCKED", metadata["productionPromotion"]["status"])
            self.assertTrue(metadata["mockModel"])
            self.assertFalse(metadata["genuineSignLanguageData"])
            self.assertTrue(metadata["onnx"]["parity"]["verified"])
            self.assertEqual(0.0, metadata["runtime"]["warmedP95LatencyMs"])
            self.assertEqual([1, 30, 224], metadata["input"]["shape"])
            self.assertEqual("features", metadata["input"]["name"])
            self.assertEqual("probabilities", metadata["output"]["name"])
            self.assertEqual("NO_SIGN", metadata["labels"][0]["id"])
            self.assertIsNone(metadata["labels"][0]["captionText"])
            self.assertNotIn("promotionEligible", metadata)
            runtime = ort.InferenceSession(onnx_path.read_bytes(), providers=["CPUExecutionProvider"])
            self.assertEqual("features", runtime.get_inputs()[0].name)
            self.assertEqual([1, 30, 224], runtime.get_inputs()[0].shape)
            self.assertEqual("probabilities", runtime.get_outputs()[0].name)
            probabilities = runtime.run(
                ["probabilities"],
                {"features": np.zeros((1, 30, 224), dtype=np.float32)},
            )[0]
            self.assertTrue(np.all((probabilities >= 0.0) & (probabilities <= 1.0)))
            np.testing.assert_allclose(probabilities.sum(axis=1), np.ones(1), atol=1e-6)
            with self.assertRaises(ManifestError):
                export_onnx(
                    checkpoint,
                    manifest,
                    root / "must-not-exist.onnx",
                    claim_genuine_sgsl=True,
                )

    def test_finalized_oov_evidence_is_bound_to_checkpoint_and_exported_fail_closed(self):
        import torch

        from signconnect_ml.config import TrainConfig
        from signconnect_ml.exporting import export_onnx
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import evaluate_checkpoint, load_checkpoint_model, train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest_path = generate_non_production_synthetic(root / "fixture", signer_count=6)
            manifest_document = json.loads(manifest_path.read_text(encoding="utf-8"))
            for sample in manifest_document["samples"]:
                if sample["labelId"] == "SYNTHETIC_B":
                    sample["labelId"] = "OUT_OF_VOCABULARY"
            manifest_path.write_text(json.dumps(manifest_document), encoding="utf-8")

            output = root / "run"
            checkpoint_path = train(
                TrainConfig(
                    seed=7,
                    model="tcn",
                    manifest=manifest_path,
                    output_dir=output,
                    epochs=1,
                    batch_size=6,
                    learning_rate=0.002,
                    hidden_size=8,
                    dropout=0.0,
                    false_final_threshold=0.8,
                )
            )
            report_path = evaluate_checkpoint(
                checkpoint_path,
                manifest_path,
                output / "split.json",
                output / "final-test.json",
                split_name="test",
                batch_size=6,
                false_final_threshold=0.8,
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))
            checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)

            self.assertEqual(report, checkpoint["evaluation"])
            self.assertRegex(report["modelStateSha256"], r"^[a-f0-9]{64}$")
            self.assertEqual(1, report["metrics"]["rejectionBehavior"]["unknownSampleCount"])
            self.assertIsNotNone(
                report["metrics"]["rejectionBehavior"]["unknownRejectionRate"]
            )

            _, metadata_path = export_onnx(
                checkpoint_path,
                manifest_path,
                root / "artifact" / "oov.onnx",
            )
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            oov = next(label for label in metadata["labels"] if label["id"] == "OUT_OF_VOCABULARY")
            self.assertEqual("REJECT", oov["outcome"])
            self.assertIsNone(oov["captionText"])
            self.assertEqual(report["metrics"], metadata["evaluation"]["metrics"])

            tampered = copy.deepcopy(checkpoint)
            tampered["evaluation"]["manifestSha256"] = "f" * 64
            tampered_path = root / "tampered-evidence.pt"
            torch.save(tampered, tampered_path)
            with self.assertRaisesRegex(ValueError, "model contract"):
                load_checkpoint_model(tampered_path)

            swapped = copy.deepcopy(checkpoint)
            tensor_name = next(iter(swapped["state_dict"]))
            swapped["state_dict"][tensor_name] = (
                swapped["state_dict"][tensor_name] + 0.25
            )
            swapped_path = root / "swapped-state.pt"
            torch.save(swapped, swapped_path)
            with self.assertRaisesRegex(ValueError, "model contract"):
                load_checkpoint_model(swapped_path)
            with self.assertRaisesRegex(ValueError, "model contract"):
                export_onnx(swapped_path, manifest_path, root / "must-not-export.onnx")

            metric_mutations = {
                "accuracy": lambda metrics: metrics.__setitem__("accuracy", 0.123),
                "macro f1": lambda metrics: metrics.__setitem__("macroF1", 0.123),
                "class precision": lambda metrics: metrics["perClass"][0].__setitem__(
                    "precision", 0.123
                ),
                "class recall": lambda metrics: metrics["perClass"][0].__setitem__(
                    "recall", 0.123
                ),
                "class f1": lambda metrics: metrics["perClass"][0].__setitem__("f1", 0.123),
            }
            for name, mutate in metric_mutations.items():
                with self.subTest(metric=name):
                    tampered = copy.deepcopy(checkpoint)
                    mutate(tampered["evaluation"]["metrics"])
                    tampered_path = root / f"tampered-{name.replace(' ', '-')}.pt"
                    torch.save(tampered, tampered_path)
                    with self.assertRaisesRegex(ValueError, "model contract"):
                        load_checkpoint_model(tampered_path)

            tampered = copy.deepcopy(checkpoint)
            behavior = tampered["evaluation"]["metrics"]["rejectionBehavior"]
            behavior["unknownSampleCount"] = 2
            behavior["unknownRejectedCount"] = 2
            behavior["unknownRejectionRate"] = 1.0
            behavior["unknownFalseFinalCount"] = 0
            behavior["unknownFalseFinalRate"] = 0.0
            tampered_path = root / "tampered-oov-support.pt"
            torch.save(tampered, tampered_path)
            with self.assertRaisesRegex(ValueError, "model contract"):
                load_checkpoint_model(tampered_path)


if __name__ == "__main__":
    unittest.main()
