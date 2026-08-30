from __future__ import annotations

import os
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from signconnect_ml.lifecycle import (
    LifecycleError,
    execute_deletion,
    inventory_artifacts,
    plan_deletion,
    report_expiry,
)


class DatasetLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "explicit-dataset-root"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_inventory_finds_every_indexed_artifact_for_a_pseudonymous_signer(self):
        paths = (
            "source/sample-a.json",
            "derived/sample-a-cache.npz",
            "checkpoints/run-a.onnx",
            "source/sample-b.json",
        )
        for relative_path in paths:
            artifact_path = self.root / relative_path
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_path.write_text("synthetic fixture", encoding="utf-8")
        index = [
            self._artifact("src-a", "SOURCE", paths[0], ["signer-a"], ["sample-a"]),
            self._artifact("cache-a", "DERIVED", paths[1], ["signer-a"], ["sample-a"]),
            self._artifact("model-a", "CHECKPOINT", paths[2], ["signer-a"], ["sample-a"]),
            self._artifact("src-b", "SOURCE", paths[3], ["signer-b"], ["sample-b"]),
        ]

        report = inventory_artifacts(self.root, index, signer_ids={"signer-a"})

        self.assertEqual(("cache-a", "model-a", "src-a"), report.artifact_ids)
        self.assertEqual(3, report.existing_count)
        self.assertEqual(0, report.missing_count)
        self.assertEqual(self.root.resolve(), report.root)

    def test_expiry_report_is_a_non_destructive_seven_day_deadline_dry_run(self):
        expired = self.root / "source/expired.json"
        active = self.root / "derived/active.npz"
        for path in (expired, active):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture", encoding="utf-8")
        index = [
            self._artifact(
                "expired-source",
                "SOURCE",
                "source/expired.json",
                ["signer-a"],
                ["sample-a"],
                "2026-08-20T00:00:00Z",
            ),
            self._artifact(
                "active-cache",
                "DERIVED",
                "derived/active.npz",
                ["signer-a"],
                ["sample-a"],
                "2026-09-30T00:00:00Z",
            ),
        ]

        report = report_expiry(
            self.root,
            index,
            as_of=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(("expired-source",), report.expired_artifact_ids)
        self.assertEqual(("expired-source",), report.overdue_artifact_ids)
        self.assertEqual(
            datetime(2026, 8, 27, tzinfo=timezone.utc),
            report.items[1].deletion_due_at,
        )
        self.assertEqual("synthetic fixture", expired.read_text(encoding="utf-8"))
        self.assertEqual("synthetic fixture", active.read_text(encoding="utf-8"))

    def test_deletion_plan_selects_exact_indexed_dependencies_without_deleting(self):
        index = [
            self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"]),
            self._artifact("cache-a", "DERIVED", "derived/a.npz", ["signer-a"], ["sample-a"]),
            self._artifact(
                "checkpoint-ab",
                "CHECKPOINT",
                "checkpoints/ab.onnx",
                ["signer-a", "signer-b"],
                ["sample-a", "sample-b"],
            ),
            self._artifact("src-b", "SOURCE", "source/b.json", ["signer-b"], ["sample-b"]),
        ]
        for artifact in index:
            path = self.root / str(artifact["path"])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture", encoding="utf-8")

        plan = plan_deletion(
            self.root,
            index,
            signer_ids={"signer-a"},
            reason="WITHDRAWAL",
            planned_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(("cache-a", "checkpoint-ab", "src-a"), plan.artifact_ids)
        self.assertTrue(plan.dry_run)
        self.assertEqual(("signer-a",), plan.requested_signer_ids)
        self.assertTrue(all((self.root / str(item["path"])).is_file() for item in index))

    def test_deletion_execution_defaults_to_denied_without_explicit_confirmation(self):
        artifact = self.root / "source/a.json"
        artifact.parent.mkdir()
        artifact.write_text("synthetic fixture", encoding="utf-8")
        plan = plan_deletion(
            self.root,
            [self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"])],
            sample_ids={"sample-a"},
            reason="WITHDRAWAL",
        )

        with self.assertRaisesRegex(LifecycleError, "explicit confirmation"):
            execute_deletion(plan)

        self.assertEqual("synthetic fixture", artifact.read_text(encoding="utf-8"))

    def test_confirmed_execution_deletes_only_exact_planned_files(self):
        selected = (
            ("src-a", "SOURCE", "source/a.json"),
            ("cache-a", "DERIVED", "derived/a.npz"),
            ("checkpoint-a", "CHECKPOINT", "checkpoints/a.onnx"),
        )
        unrelated = self.root / "source/unrelated.json"
        for _, _, relative_path in selected:
            artifact = self.root / relative_path
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text("synthetic fixture", encoding="utf-8")
        unrelated.write_text("must remain", encoding="utf-8")
        index = [
            self._artifact(artifact_id, kind, path, ["signer-a"], ["sample-a"])
            for artifact_id, kind, path in selected
        ]
        plan = plan_deletion(
            self.root,
            index,
            signer_ids={"signer-a"},
            reason="WITHDRAWAL",
        )

        result = execute_deletion(plan, confirm=True)

        self.assertEqual(("cache-a", "checkpoint-a", "src-a"), result.deleted_artifact_ids)
        self.assertEqual((), result.missing_artifact_ids)
        self.assertFalse(result.dry_run)
        self.assertTrue(unrelated.is_file())
        self.assertTrue(all(not (self.root / path).exists() for _, _, path in selected))

    def test_inventory_rejects_parent_path_aliases_even_when_they_end_inside_root(self):
        index = [
            self._artifact(
                "aliased-source",
                "SOURCE",
                "source/../source/a.json",
                ["signer-a"],
                ["sample-a"],
            )
        ]

        with self.assertRaisesRegex(LifecycleError, "exact relative file paths"):
            inventory_artifacts(self.root, index)

    def test_expired_source_plan_includes_its_derivatives_but_not_active_sibling_sample(self):
        index = [
            self._artifact(
                "src-expired",
                "SOURCE",
                "source/expired.json",
                ["signer-a"],
                ["sample-expired"],
                "2026-08-20T00:00:00Z",
            ),
            self._artifact(
                "cache-expired",
                "DERIVED",
                "derived/expired.npz",
                ["signer-a"],
                ["sample-expired"],
                "2026-09-30T00:00:00Z",
            ),
            self._artifact(
                "checkpoint-expired",
                "CHECKPOINT",
                "checkpoints/expired.onnx",
                ["signer-a"],
                ["sample-expired"],
                "2026-09-30T00:00:00Z",
            ),
            self._artifact(
                "src-active",
                "SOURCE",
                "source/active.json",
                ["signer-a"],
                ["sample-active"],
                "2026-09-30T00:00:00Z",
            ),
        ]

        plan = plan_deletion(
            self.root,
            index,
            signer_ids={"signer-a"},
            reason="RETENTION_EXPIRED",
            planned_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(
            ("cache-expired", "checkpoint-expired", "src-expired"),
            plan.artifact_ids,
        )

    def test_index_rejects_two_artifact_ids_for_the_same_resolved_file(self):
        index = [
            self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"]),
            self._artifact("alias-a", "DERIVED", "source/a.json", ["signer-a"], ["sample-a"]),
        ]

        with self.assertRaisesRegex(LifecycleError, "same resolved path"):
            inventory_artifacts(self.root, index)

    def test_index_rejects_globs_absolute_paths_and_root_escapes(self):
        unsafe_paths = (
            "source/*.json",
            str((self.root.parent / "outside.json").resolve()),
            "../outside.json",
        )
        for unsafe_path in unsafe_paths:
            with self.subTest(path=unsafe_path):
                index = [
                    self._artifact(
                        "unsafe",
                        "SOURCE",
                        unsafe_path,
                        ["signer-a"],
                        ["sample-a"],
                    )
                ]
                with self.assertRaises(LifecycleError):
                    inventory_artifacts(self.root, index)

    def test_deletion_plan_rejects_a_bare_string_selector(self):
        index = [
            self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"])
        ]

        with self.assertRaisesRegex(LifecycleError, "collection"):
            plan_deletion(
                self.root,
                index,
                signer_ids="signer-a",
                reason="WITHDRAWAL",
            )

    def test_source_index_entry_requires_a_sample_id_for_expiry_dependency_closure(self):
        index = [
            self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], [])
        ]

        with self.assertRaisesRegex(LifecycleError, "SOURCE.*sample ID"):
            inventory_artifacts(self.root, index)

    def test_deletion_plan_never_allows_an_unscoped_broad_selection(self):
        artifact = self.root / "source/a.json"
        artifact.parent.mkdir()
        artifact.write_text("synthetic fixture", encoding="utf-8")
        index = [
            self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"])
        ]

        with self.assertRaisesRegex(LifecycleError, "signer ID or sample ID"):
            plan_deletion(self.root, index, reason="WITHDRAWAL")

        self.assertTrue(artifact.is_file())

    def test_execution_preflights_the_whole_plan_before_deleting_any_file(self):
        safe_file = self.root / "source/a.json"
        unsafe_later = self.root / "source/z.json"
        safe_file.parent.mkdir()
        safe_file.write_text("synthetic fixture", encoding="utf-8")
        index = [
            self._artifact("a-safe", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"]),
            self._artifact("z-unsafe", "DERIVED", "source/z.json", ["signer-a"], ["sample-a"]),
        ]
        plan = plan_deletion(
            self.root,
            index,
            signer_ids={"signer-a"},
            reason="WITHDRAWAL",
        )
        unsafe_later.mkdir()

        with self.assertRaisesRegex(LifecycleError, "indexed files only"):
            execute_deletion(plan, confirm=True)

        self.assertTrue(safe_file.is_file())

    def test_execution_refuses_a_file_that_appeared_after_the_dry_run(self):
        appeared = self.root / "source/appeared.json"
        index = [
            self._artifact(
                "appeared",
                "SOURCE",
                "source/appeared.json",
                ["signer-a"],
                ["sample-a"],
            )
        ]
        plan = plan_deletion(
            self.root,
            index,
            sample_ids={"sample-a"},
            reason="WITHDRAWAL",
        )
        appeared.parent.mkdir()
        appeared.write_text("not present during planning", encoding="utf-8")

        with self.assertRaisesRegex(LifecycleError, "changed after planning"):
            execute_deletion(plan, confirm=True)

        self.assertEqual("not present during planning", appeared.read_text(encoding="utf-8"))

    def test_execution_refuses_same_size_replacement_with_preserved_file_times(self):
        artifact = self.root / "source/a.json"
        artifact.parent.mkdir()
        artifact.write_text("original", encoding="utf-8")
        original_stat = artifact.stat()
        plan = plan_deletion(
            self.root,
            [self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"])],
            sample_ids={"sample-a"},
            reason="WITHDRAWAL",
        )
        artifact.write_text("replaced", encoding="utf-8")
        os.utime(
            artifact,
            ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
        )

        with self.assertRaisesRegex(LifecycleError, "changed after planning"):
            execute_deletion(plan, confirm=True)

        self.assertEqual("replaced", artifact.read_text(encoding="utf-8"))

    def test_execution_refuses_a_plan_with_its_pseudonymous_scope_removed(self):
        artifact = self.root / "source/a.json"
        artifact.parent.mkdir()
        artifact.write_text("synthetic fixture", encoding="utf-8")
        plan = plan_deletion(
            self.root,
            [self._artifact("src-a", "SOURCE", "source/a.json", ["signer-a"], ["sample-a"])],
            signer_ids={"signer-a"},
            reason="WITHDRAWAL",
        )
        altered = replace(plan, requested_signer_ids=())

        with self.assertRaisesRegex(LifecycleError, "validated pseudonymous scope"):
            execute_deletion(altered, confirm=True)

        self.assertTrue(artifact.is_file())

    @staticmethod
    def _artifact(
        artifact_id: str,
        kind: str,
        path: str,
        signer_ids: list[str],
        sample_ids: list[str],
        retention_expires_at: str = "2030-01-01T00:00:00Z",
    ) -> dict[str, object]:
        return {
            "artifactId": artifact_id,
            "kind": kind,
            "path": path,
            "signerIds": signer_ids,
            "sampleIds": sample_ids,
            "retentionExpiresAt": retention_expires_at,
        }


if __name__ == "__main__":
    unittest.main()
