import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


class TrainingReproducibilityTest(unittest.TestCase):
    def test_source_provenance_binds_tracked_and_untracked_content_without_leaks(self):
        from signconnect_ml.config import TrainConfig
        from signconnect_ml.training import build_reproducibility_evidence

        empty_sha256 = hashlib.sha256(b"").hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary) / "repository"
            package_root = repository / "ml" / "sign-recognition"
            package_root.mkdir(parents=True)
            (package_root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
            tracked = package_root / "training_source.py"
            tracked.write_text("SAFE_VALUE = 1\n", encoding="utf-8")

            def git(*arguments: str) -> None:
                subprocess.run(
                    ["git", "-C", str(repository), *arguments],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )

            git("init")
            git("config", "user.email", "test@signconnect.local")
            git("config", "user.name", "SignConnect Test")
            git("add", "ml/sign-recognition")
            git("commit", "-m", "test fixture")
            config = TrainConfig(
                seed=7,
                model="tcn",
                manifest=Path("private/manifest.json"),
                output_dir=Path("private/output"),
                epochs=1,
                batch_size=2,
                learning_rate=0.001,
                hidden_size=8,
                dropout=0.0,
                false_final_threshold=0.8,
            )

            clean = build_reproducibility_evidence(config, package_root=package_root)
            self.assertEqual(
                {
                    "commit",
                    "dirty",
                    "trackedChangesSha256",
                    "untrackedFileCount",
                    "untrackedStateSha256",
                    "untrackedContentSha256",
                },
                set(clean["sourceControl"]),
            )
            self.assertFalse(clean["sourceControl"]["dirty"])
            self.assertEqual(0, clean["sourceControl"]["untrackedFileCount"])
            self.assertEqual(empty_sha256, clean["sourceControl"]["trackedChangesSha256"])
            self.assertEqual(empty_sha256, clean["sourceControl"]["untrackedStateSha256"])
            self.assertEqual(empty_sha256, clean["sourceControl"]["untrackedContentSha256"])

            sensitive_name = "private-participant-note.txt"
            sensitive_content = "never expose this participant detail"
            (package_root / sensitive_name).write_text(sensitive_content, encoding="utf-8")
            untracked = build_reproducibility_evidence(config, package_root=package_root)

            self.assertTrue(untracked["sourceControl"]["dirty"])
            self.assertEqual(1, untracked["sourceControl"]["untrackedFileCount"])
            self.assertNotEqual(
                empty_sha256, untracked["sourceControl"]["untrackedStateSha256"]
            )
            self.assertNotEqual(
                empty_sha256, untracked["sourceControl"]["untrackedContentSha256"]
            )
            self.assertNotIn(sensitive_name, repr(untracked))
            self.assertNotIn(sensitive_content, repr(untracked))
            self.assertNotIn(str(repository), repr(untracked))

            tracked.write_text("SAFE_VALUE = 2\n", encoding="utf-8")
            changed = build_reproducibility_evidence(config, package_root=package_root)
            self.assertNotEqual(
                empty_sha256, changed["sourceControl"]["trackedChangesSha256"]
            )

    def test_config_declares_reproducible_training_inputs_and_hashes_semantics(self):
        from signconnect_ml.config import TrainConfig, config_sha256, load_config
        from signconnect_ml.constants import FEATURE_CONTRACT

        config = load_config(
            Path(__file__).parents[1] / "configs" / "tcn-v1.toml"
        )

        self.assertEqual(FEATURE_CONTRACT, config.input_contract_version)
        self.assertEqual("none", config.augmentation_policy)
        self.assertEqual("adam", config.optimizer_name)
        self.assertEqual("constant", config.learning_rate_schedule)
        self.assertEqual((0.6, 0.7, 0.8, 0.9), config.threshold_candidates)

        with tempfile.TemporaryDirectory() as temporary:
            other_paths = TrainConfig(
                seed=config.seed,
                model=config.model,
                manifest=Path(temporary) / "manifest.json",
                output_dir=Path(temporary) / "output",
                epochs=config.epochs,
                batch_size=config.batch_size,
                learning_rate=config.learning_rate,
                hidden_size=config.hidden_size,
                dropout=config.dropout,
                false_final_threshold=config.false_final_threshold,
                input_contract_version=config.input_contract_version,
                augmentation_policy=config.augmentation_policy,
                optimizer_name=config.optimizer_name,
                learning_rate_schedule=config.learning_rate_schedule,
                threshold_candidates=config.threshold_candidates,
            )
            changed_learning_rate = TrainConfig(
                **{
                    **other_paths.__dict__,
                    "learning_rate": config.learning_rate * 2,
                }
            )

        self.assertRegex(config_sha256(config), r"^[a-f0-9]{64}$")
        self.assertEqual(config_sha256(config), config_sha256(other_paths))
        self.assertNotEqual(
            config_sha256(config), config_sha256(changed_learning_rate)
        )

    def test_validation_threshold_sweep_has_a_deterministic_lowest_threshold_tie_break(self):
        import torch

        from signconnect_ml.training import select_validation_threshold

        class AlwaysNoSign(torch.nn.Module):
            def __init__(self, class_count: int) -> None:
                super().__init__()
                self.class_count = class_count

            def forward(self, features):
                return torch.zeros(
                    (features.shape[0], self.class_count), dtype=features.dtype
                )

        class ValidationDataset(torch.utils.data.Dataset):
            unknown_mask = (False, False)

            def __len__(self):
                return 2

            def __getitem__(self, index):
                return torch.zeros((30, 224)), torch.tensor(index)

        selection = select_validation_threshold(
            AlwaysNoSign(class_count=2),
            ValidationDataset(),
            SimpleNamespace(no_sign_index=0, reject_indices=()),
            batch_size=2,
            candidates=(0.2, 0.8),
        )

        self.assertEqual(0.2, selection.selected_threshold)
        self.assertEqual(
            {
                "split": "validation",
                "objective": "minimize_false_final_rate_then_rejection_rate",
                "candidates": [0.2, 0.8],
                "tieBreak": "lowest_threshold",
                "selectedThreshold": 0.2,
                "results": [
                    {
                        "threshold": 0.2,
                        "falseFinalRate": 0.0,
                        "rejectionRate": 0.0,
                    },
                    {
                        "threshold": 0.8,
                        "falseFinalRate": 0.0,
                        "rejectionRate": 0.0,
                    },
                ],
            },
            selection.evidence,
        )

    def test_reproducibility_evidence_binds_config_lockfile_and_source_revision(self):
        from signconnect_ml.config import TrainConfig, config_sha256
        from signconnect_ml.training import build_reproducibility_evidence

        package_root = Path(__file__).parents[1]
        config = TrainConfig(
            seed=7,
            model="tcn",
            manifest=Path("private/manifest.json"),
            output_dir=Path("private/output"),
            epochs=1,
            batch_size=2,
            learning_rate=0.001,
            hidden_size=8,
            dropout=0.0,
            false_final_threshold=0.8,
        )

        evidence = build_reproducibility_evidence(config)

        expected_lock_hash = hashlib.sha256(
            (package_root / "uv.lock").read_bytes()
        ).hexdigest()
        self.assertEqual(1, evidence["schemaVersion"])
        self.assertEqual(config_sha256(config), evidence["configSha256"])
        self.assertEqual(
            {"file": "uv.lock", "sha256": expected_lock_hash},
            evidence["dependencyLock"],
        )
        self.assertEqual(
            {
                "commit",
                "dirty",
                "trackedChangesSha256",
                "untrackedFileCount",
                "untrackedStateSha256",
                "untrackedContentSha256",
            },
            set(evidence["sourceControl"]),
        )
        commit = evidence["sourceControl"]["commit"]
        self.assertTrue(commit is None or 40 <= len(commit) <= 64)
        self.assertIsInstance(evidence["sourceControl"]["dirty"], (bool, type(None)))
        self.assertNotIn("private", repr(evidence))

    def test_training_persists_reproducibility_and_validation_threshold_evidence(self):
        import torch

        from signconnect_ml.config import TrainConfig, config_sha256
        from signconnect_ml.constants import FEATURE_CONTRACT
        from signconnect_ml.synthetic import generate_non_production_synthetic
        from signconnect_ml.training import load_checkpoint_model, train

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = generate_non_production_synthetic(
                root / "fixture", signer_count=6
            )
            config = TrainConfig(
                seed=7,
                model="tcn",
                manifest=manifest,
                output_dir=root / "run",
                epochs=1,
                batch_size=6,
                learning_rate=0.002,
                hidden_size=8,
                dropout=0.0,
                false_final_threshold=0.8,
                threshold_candidates=(0.2, 0.8),
            )

            checkpoint_path = train(config)
            checkpoint = torch.load(
                checkpoint_path, map_location="cpu", weights_only=True
            )
            load_checkpoint_model(checkpoint_path, allow_pending_final_test=True)

        self.assertEqual(2, checkpoint["schema_version"])
        self.assertEqual(FEATURE_CONTRACT, checkpoint["config"]["input_contract_version"])
        self.assertEqual("none", checkpoint["config"]["augmentation_policy"])
        self.assertEqual("adam", checkpoint["config"]["optimizer_name"])
        self.assertEqual("constant", checkpoint["config"]["learning_rate_schedule"])
        self.assertEqual([0.2, 0.8], checkpoint["config"]["threshold_candidates"])
        self.assertEqual(config_sha256(config), checkpoint["reproducibility"]["configSha256"])
        self.assertEqual("validation", checkpoint["threshold_selection"]["split"])
        self.assertEqual(
            [0.2, 0.8], checkpoint["threshold_selection"]["candidates"]
        )
        self.assertEqual(
            checkpoint["minimum_confidence"],
            checkpoint["threshold_selection"]["selectedThreshold"],
        )
        self.assertEqual(
            checkpoint["threshold_selection"]["selectedThreshold"],
            checkpoint["evaluation"]["metrics"]["rejectionBehavior"][
                "minimumConfidence"
            ],
        )


if __name__ == "__main__":
    unittest.main()
