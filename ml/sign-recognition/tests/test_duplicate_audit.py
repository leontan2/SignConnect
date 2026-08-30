from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from signconnect_ml.duplicate_audit import DuplicateAuditError, audit_duplicate_leakage


class DuplicateAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _sample(
        self,
        sample_id: str,
        signer_id: str,
        split: str,
        features: np.ndarray,
    ) -> dict[str, object]:
        relative_path = f"samples/{sample_id}.npz"
        artifact_path = self.root / relative_path
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(artifact_path, features=np.asarray(features, dtype=np.float32))
        return {
            "sampleId": sample_id,
            "signerId": signer_id,
            "splitAssignment": split,
            "landmarkArtifact": {
                "path": relative_path,
                "sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            },
        }

    def test_exact_tensor_duplicate_across_splits_blocks_with_safe_identity_report(self):
        features = np.arange(24, dtype=np.float32).reshape(3, 8)
        samples = [
            self._sample("sample-train", "signer-a", "train", features),
            self._sample("sample-test", "signer-b", "test", features),
        ]

        report = audit_duplicate_leakage(data_root=self.root, samples=samples)

        self.assertEqual("BLOCKED", report.status)
        self.assertEqual(2, report.sample_count)
        self.assertEqual(1, len(report.findings))
        finding = report.findings[0]
        self.assertEqual("EXACT_SHA256", finding.kind)
        self.assertEqual("sample-test", finding.left.sample_id)
        self.assertEqual("test", finding.left.split)
        self.assertEqual("signer-b", finding.left.signer_id)
        self.assertEqual("sample-train", finding.right.sample_id)
        self.assertEqual("train", finding.right.split)
        self.assertEqual("signer-a", finding.right.signer_id)
        self.assertEqual(1.0, finding.similarity)
        self.assertFalse(hasattr(finding, "features"))

    def test_near_duplicate_across_signers_has_deterministic_fingerprint_and_order(self):
        baseline = np.linspace(-1.0, 1.0, num=96, dtype=np.float32).reshape(6, 16)
        changed = baseline.copy()
        changed[0, 0] += np.float32(0.0001)
        samples = [
            self._sample("sample-z", "signer-a", "validation", baseline),
            self._sample("sample-a", "signer-b", "validation", changed),
        ]

        first = audit_duplicate_leakage(data_root=self.root, samples=samples)
        second = audit_duplicate_leakage(data_root=self.root, samples=reversed(samples))

        self.assertEqual(first, second)
        self.assertEqual("BLOCKED", first.status)
        self.assertEqual("NEAR_DUPLICATE", first.findings[0].kind)
        self.assertGreaterEqual(first.findings[0].similarity, 0.9999)
        self.assertLess(first.findings[0].similarity, 1.0)
        self.assertEqual(["sample-a", "sample-z"], [item.sample_id for item in first.fingerprints])
        self.assertTrue(all(len(item.near_sha256) == 64 for item in first.fingerprints))
        self.assertTrue(all(not hasattr(item, "features") for item in first.fingerprints))

    def test_non_finite_tensor_fails_closed_without_exposing_tensor_values(self):
        features = np.zeros((3, 8), dtype=np.float32)
        features[1, 2] = np.nan
        sample = self._sample("sample-nan", "signer-a", "train", features)

        with self.assertRaises(DuplicateAuditError) as caught:
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

        message = str(caught.exception)
        self.assertIn("sample-nan", message)
        self.assertIn("non-finite", message)
        self.assertNotIn("nan", message.replace("sample-nan", "" ).lower())

    def test_path_escape_is_rejected_before_an_outside_tensor_is_read(self):
        outside = self.root.parent / "outside-private-tensor.npz"
        np.savez_compressed(outside, features=np.zeros((3, 8), dtype=np.float32))
        self.addCleanup(outside.unlink, missing_ok=True)
        sample = {
            "sampleId": "sample-escape",
            "signerId": "signer-a",
            "splitAssignment": "train",
            "landmarkArtifact": {
                "path": "../outside-private-tensor.npz",
                "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
            },
        }

        with self.assertRaisesRegex(DuplicateAuditError, "sample-escape.*data root"):
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

    def test_symlink_is_rejected_even_when_its_target_stays_inside_data_root(self):
        target = self._sample(
            "real-target",
            "signer-a",
            "train",
            np.ones((3, 8), dtype=np.float32),
        )
        target_path = self.root / str(target["landmarkArtifact"]["path"])
        link_dir = self.root / "linked-samples"
        linked_with_junction = False
        try:
            link_dir.symlink_to(target_path.parent, target_is_directory=True)
        except OSError as exc:
            if os.name != "nt":
                self.skipTest(f"filesystem symlinks unavailable: {exc}")
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link_dir), str(target_path.parent)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                self.skipTest(f"filesystem links unavailable: {exc}")
            linked_with_junction = True
        sample = {
            "sampleId": "sample-link",
            "signerId": "signer-b",
            "splitAssignment": "test",
            "landmarkArtifact": {
                "path": str((link_dir / target_path.name).relative_to(self.root)),
                "sha256": hashlib.sha256(target_path.read_bytes()).hexdigest(),
            },
        }

        try:
            with self.assertRaisesRegex(DuplicateAuditError, "sample-link.*symbolic link"):
                audit_duplicate_leakage(data_root=self.root, samples=[sample])
        finally:
            if linked_with_junction:
                link_dir.rmdir()
            else:
                link_dir.unlink()

    def test_missing_artifact_fails_closed_with_only_the_sample_identity(self):
        sample = {
            "sampleId": "sample-missing",
            "signerId": "signer-a",
            "splitAssignment": "train",
            "landmarkArtifact": {
                "path": "private/missing.npz",
                "sha256": "0" * 64,
            },
        }

        with self.assertRaises(DuplicateAuditError) as caught:
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

        self.assertEqual(
            "Duplicate audit rejected sample-missing: artifact is missing",
            str(caught.exception),
        )

    def test_declared_artifact_digest_must_match_the_file_before_comparison(self):
        sample = self._sample(
            "sample-tampered",
            "signer-a",
            "train",
            np.ones((3, 8), dtype=np.float32),
        )
        sample["landmarkArtifact"]["sha256"] = "0" * 64

        with self.assertRaisesRegex(DuplicateAuditError, "sample-tampered.*digest mismatch"):
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

    def test_malformed_archive_fails_closed(self):
        artifact = self.root / "samples" / "corrupt.npz"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(b"not a numpy archive")
        sample = {
            "sampleId": "sample-corrupt",
            "signerId": "signer-a",
            "splitAssignment": "train",
            "landmarkArtifact": {
                "path": "samples/corrupt.npz",
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            },
        }

        with self.assertRaisesRegex(DuplicateAuditError, "sample-corrupt.*invalid tensor archive"):
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

    def test_existing_manifest_style_sample_objects_are_supported(self):
        record = self._sample(
            "sample-object",
            "signer-a",
            "train",
            np.arange(24, dtype=np.float32).reshape(3, 8),
        )
        artifact = record["landmarkArtifact"]
        sample = SimpleNamespace(
            sample_id=record["sampleId"],
            signer_id=record["signerId"],
            split_assignment=record["splitAssignment"],
            path=artifact["path"],
            artifact_sha256=artifact["sha256"],
        )

        report = audit_duplicate_leakage(data_root=self.root, samples=[sample])

        self.assertEqual("PASS", report.status)
        self.assertEqual("sample-object", report.fingerprints[0].sample_id)

    def test_empty_sample_collection_fails_closed(self):
        with self.assertRaisesRegex(DuplicateAuditError, "at least one sample"):
            audit_duplicate_leakage(data_root=self.root, samples=[])

    def test_invalid_near_duplicate_threshold_fails_closed(self):
        sample = self._sample(
            "sample-a",
            "signer-a",
            "train",
            np.ones((3, 8), dtype=np.float32),
        )

        for threshold in (float("nan"), float("inf"), -0.1, 1.1):
            with self.subTest(threshold=threshold):
                with self.assertRaisesRegex(DuplicateAuditError, "threshold"):
                    audit_duplicate_leakage(
                        data_root=self.root,
                        samples=[sample],
                        near_duplicate_threshold=threshold,
                    )

    def test_unknown_split_name_fails_closed(self):
        sample = self._sample(
            "sample-a",
            "signer-a",
            "production",
            np.ones((3, 8), dtype=np.float32),
        )

        with self.assertRaisesRegex(DuplicateAuditError, "sample-a.*split"):
            audit_duplicate_leakage(data_root=self.root, samples=[sample])

    def test_duplicate_sample_identity_fails_closed(self):
        first = self._sample(
            "sample-a",
            "signer-a",
            "train",
            np.ones((3, 8), dtype=np.float32),
        )
        second = self._sample(
            "sample-a-copy",
            "signer-b",
            "test",
            np.zeros((3, 8), dtype=np.float32),
        )
        second["sampleId"] = "sample-a"

        with self.assertRaisesRegex(DuplicateAuditError, "duplicate sample ID.*sample-a"):
            audit_duplicate_leakage(data_root=self.root, samples=[first, second])

    def test_incomplete_sample_record_fails_closed(self):
        with self.assertRaisesRegex(DuplicateAuditError, "invalid sample record"):
            audit_duplicate_leakage(
                data_root=self.root,
                samples=[
                    {
                        "sampleId": "sample-incomplete",
                        "splitAssignment": "train",
                        "landmarkArtifact": {"path": "unused.npz", "sha256": "0" * 64},
                    }
                ],
            )

    def test_inconsistent_tensor_shapes_fail_closed(self):
        samples = [
            self._sample(
                "sample-a",
                "signer-a",
                "train",
                np.ones((3, 8), dtype=np.float32),
            ),
            self._sample(
                "sample-b",
                "signer-b",
                "test",
                np.ones((4, 8), dtype=np.float32),
            ),
        ]

        with self.assertRaisesRegex(DuplicateAuditError, "sample-b.*tensor shape"):
            audit_duplicate_leakage(data_root=self.root, samples=samples)

    def test_symbolic_data_root_fails_closed(self):
        sample = self._sample(
            "sample-a",
            "signer-a",
            "train",
            np.ones((3, 8), dtype=np.float32),
        )
        linked_root = self.root.parent / f"{self.root.name}-linked-root"
        linked_with_junction = False
        try:
            linked_root.symlink_to(self.root, target_is_directory=True)
        except OSError as exc:
            if os.name != "nt":
                self.skipTest(f"filesystem symlinks unavailable: {exc}")
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(linked_root), str(self.root)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                self.skipTest(f"filesystem links unavailable: {exc}")
            linked_with_junction = True

        try:
            with self.assertRaisesRegex(DuplicateAuditError, "data root.*symbolic link"):
                audit_duplicate_leakage(data_root=linked_root, samples=[sample])
        finally:
            if linked_with_junction:
                linked_root.rmdir()
            else:
                linked_root.unlink()

    def test_duplicate_within_one_signer_and_split_is_not_a_leakage_boundary(self):
        features = np.arange(24, dtype=np.float32).reshape(3, 8)
        samples = [
            self._sample("sample-a", "signer-a", "train", features),
            self._sample("sample-b", "signer-a", "train", features),
        ]

        report = audit_duplicate_leakage(data_root=self.root, samples=samples)

        self.assertEqual("PASS", report.status)
        self.assertEqual((), report.findings)


if __name__ == "__main__":
    unittest.main()
