import json
import tempfile
import unittest
from pathlib import Path

from signconnect_ml.manifest import (
    ManifestError,
    load_manifest,
    require_genuine_sgsl,
    require_training_authorization,
)
from signconnect_ml.contracts import contract_root, validate_contract_document
from signconnect_ml.splits import create_signer_grouped_split
from signconnect_ml.synthetic import generate_non_production_synthetic


class ManifestAndSplitTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest_path = generate_non_production_synthetic(self.root / "fixture", signer_count=6)

    def tearDown(self):
        self.temporary.cleanup()

    def test_synthetic_manifest_is_explicitly_non_production_and_not_promotable(self):
        manifest = load_manifest(self.manifest_path)

        self.assertEqual("NON_PRODUCTION_SYNTHETIC", manifest.provenance_status)
        self.assertTrue(manifest.synthetic)
        self.assertEqual(("NO_SIGN", "SYNTHETIC_A", "SYNTHETIC_B"), manifest.classes)
        self.assertEqual("1.0.0-synthetic", manifest.purpose_version)
        self.assertEqual("1.0.0-synthetic", manifest.consent_notice_version)
        self.assertEqual("1.0.0-synthetic", manifest.vocabulary_version)
        self.assertEqual("Synthetic A", manifest.caption_text("SYNTHETIC_A"))
        self.assertEqual("NOT_APPLICABLE", manifest.samples[0].handedness)
        self.assertEqual(
            {
                "lighting",
                "background",
                "cameraPosition",
                "occlusion",
                "speed",
                "distance",
                "scenario",
            },
            set(manifest.samples[0].capture_condition),
        )
        with self.assertRaisesRegex(ManifestError, "Genuine SgSL provenance"):
            require_genuine_sgsl(manifest)
        require_training_authorization(manifest)
        validate_contract_document(manifest.document, "dataset-manifest.schema.json")

    def test_renaming_a_synthetic_dataset_cannot_claim_genuine_provenance(self):
        document = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        document["datasetId"] = "apparently-genuine-sgsl-dataset"
        renamed = self.root / "renamed-synthetic.json"
        renamed.write_text(json.dumps(document), encoding="utf-8")

        manifest = load_manifest(renamed)

        self.assertEqual("NON_PRODUCTION_SYNTHETIC", manifest.provenance_status)
        self.assertTrue(manifest.synthetic)
        with self.assertRaisesRegex(ManifestError, "Genuine SgSL provenance"):
            require_genuine_sgsl(manifest)

    def test_checked_in_template_satisfies_the_shared_schema_and_semantics(self):
        template = (
            Path(__file__).parents[1]
            / "fixtures"
            / "NON_PRODUCTION_SYNTHETIC"
            / "manifest.template.json"
        )
        validate_contract_document(
            json.loads(template.read_text(encoding="utf-8")),
            "dataset-manifest.schema.json",
        )

    def test_split_is_deterministic_and_has_no_signer_leakage(self):
        manifest = load_manifest(self.manifest_path)
        first = create_signer_grouped_split(manifest, seed=17)
        second = create_signer_grouped_split(manifest, seed=17)
        self.assertEqual(first, second)

        signer_by_sample = {sample.sample_id: sample.signer_id for sample in manifest.samples}
        signer_sets = [
            {signer_by_sample[sample_id] for sample_id in first.sample_ids(name)}
            for name in ("train", "validation", "test")
        ]
        self.assertTrue(signer_sets[0].isdisjoint(signer_sets[1]))
        self.assertTrue(signer_sets[0].isdisjoint(signer_sets[2]))
        self.assertTrue(signer_sets[1].isdisjoint(signer_sets[2]))

    def test_reviewed_vocabulary_order_is_the_canonical_class_order(self):
        document = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        document["reviewedLabels"].reverse()
        reordered = self.root / "reordered-vocabulary.json"
        reordered.write_text(json.dumps(document), encoding="utf-8")

        manifest = load_manifest(reordered)

        self.assertEqual(("NO_SIGN", "SYNTHETIC_B", "SYNTHETIC_A"), manifest.classes)
        self.assertEqual("Synthetic B", manifest.caption_text("SYNTHETIC_B"))

    def test_reserved_out_of_vocabulary_class_is_not_claimed_as_reviewed(self):
        document = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        document["samples"][0]["labelId"] = "OUT_OF_VOCABULARY"
        with_oov = self.root / "with-oov.json"
        with_oov.write_text(json.dumps(document), encoding="utf-8")

        manifest = load_manifest(with_oov)

        self.assertEqual("OUT_OF_VOCABULARY", manifest.classes[-1])
        self.assertIsNone(manifest.caption_text("OUT_OF_VOCABULARY"))

    def test_manifest_without_no_sign_is_rejected(self):
        document = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        document["samples"] = [
            sample for sample in document["samples"] if sample["labelId"] != "NO_SIGN"
        ]
        document["splitPolicy"]["assignmentSha256"] = (
            "6bc149fb93f76dde6e8777ecfb413606f68d52a4dde531f8b120a83738f1edc0"
        )
        invalid = self.root / "missing-no-sign.json"
        invalid.write_text(json.dumps(document), encoding="utf-8")

        with self.assertRaisesRegex(ManifestError, "explicitly include NO_SIGN"):
            load_manifest(invalid)

    def test_manifest_cannot_escape_its_data_root(self):
        document = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        document["samples"][0]["landmarkArtifact"]["path"] = "../private-sample.npz"
        invalid = self.root / "unsafe.json"
        invalid.write_text(json.dumps(document), encoding="utf-8")

        with self.assertRaisesRegex(ManifestError, "validation failed"):
            load_manifest(invalid)

    def test_training_authorization_rechecks_active_withdrawal_status(self):
        manifest = load_manifest(
            contract_root() / "fixtures" / "dataset-manifest.valid.json"
        )
        manifest.document["samples"][0]["consentAttestation"]["withdrawalStatus"] = (
            "WITHDRAWN"
        )

        with self.assertRaisesRegex(ManifestError, "active consent"):
            require_training_authorization(manifest)


if __name__ == "__main__":
    unittest.main()
