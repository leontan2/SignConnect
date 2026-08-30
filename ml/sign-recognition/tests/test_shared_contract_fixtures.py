import json
import unittest

from signconnect_ml.contracts import ContractError, contract_root, validate_contract_document


class SharedContractFixtureTest(unittest.TestCase):
    def test_schema_errors_report_only_pointer_and_keyword(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        sensitive_signer = "sgn_sensitive_value"
        sensitive_path = "../private/sensitive-landmarks.npz"
        document["samples"][0]["signerId"] = sensitive_signer
        document["samples"][0]["landmarkArtifact"]["path"] = sensitive_path

        with self.assertRaises(ContractError) as raised:
            validate_contract_document(document, "dataset-manifest.schema.json")

        message = str(raised.exception)
        self.assertIn("/samples/0/signerId", message)
        self.assertIn("/samples/0/landmarkArtifact/path", message)
        self.assertIn("keyword=pattern", message)
        self.assertNotIn(sensitive_signer, message)
        self.assertNotIn(sensitive_path, message)

    def test_semantic_errors_do_not_expose_signer_ids(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        sensitive_signer = document["samples"][0]["signerId"]
        document["samples"][2]["signerId"] = sensitive_signer

        with self.assertRaises(ContractError) as raised:
            validate_contract_document(document, "dataset-manifest.schema.json")

        message = str(raised.exception)
        self.assertIn("/samples/2/signerId", message)
        self.assertIn("keyword=signerSplitDisjoint", message)
        self.assertNotIn(sensitive_signer, message)

    def test_python_validator_matches_all_authoritative_fixture_expectations(self):
        fixtures = contract_root() / "fixtures"
        documents = sorted(fixtures.glob("*.json"))
        self.assertGreaterEqual(len(documents), 1)
        for path in documents:
            schema = (
                "dataset-manifest.schema.json"
                if path.name.startswith("dataset-manifest")
                else "model-metadata.schema.json"
            )
            expected_valid = path.name.endswith(".valid.json")
            with self.subTest(fixture=path.name):
                try:
                    validate_contract_document(
                        json.loads(path.read_text(encoding="utf-8")),
                        schema,
                    )
                    actual_valid = True
                except ContractError:
                    actual_valid = False
                self.assertEqual(expected_valid, actual_valid)

    def test_approved_metadata_requires_a_measured_positive_warmed_java_latency(self):
        document = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["runtime"]["warmedP95LatencyMs"] = 0

        with self.assertRaises(ContractError):
            validate_contract_document(document, "model-metadata.schema.json")

    def test_approved_metadata_requires_detailed_class_and_rejection_evidence(self):
        source = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        for missing in ("perClass", "confusionMatrix", "noSignBehavior", "rejectionBehavior"):
            with self.subTest(missing=missing):
                document = json.loads(json.dumps(source))
                del document["evaluation"]["metrics"][missing]
                with self.assertRaises(ContractError):
                    validate_contract_document(document, "model-metadata.schema.json")

    def test_approved_metadata_requires_measured_unknown_rejection_behavior(self):
        document = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        behavior = document["evaluation"]["metrics"]["rejectionBehavior"]
        behavior["unknownSampleCount"] = 0
        behavior["unknownRejectedCount"] = 0
        behavior["unknownFalseFinalCount"] = 0
        behavior["unknownRejectionRate"] = None
        behavior["unknownFalseFinalRate"] = None

        with self.assertRaises(ContractError):
            validate_contract_document(document, "model-metadata.schema.json")

    def test_rich_metrics_must_be_derived_from_the_confusion_matrix(self):
        source = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        mutations = {
            "accuracy": lambda metrics: metrics.__setitem__("accuracy", 0.81),
            "macro f1": lambda metrics: metrics.__setitem__("macroF1", 0.81),
            "class precision": lambda metrics: metrics["perClass"][1].__setitem__(
                "precision", 0.81
            ),
            "class recall": lambda metrics: metrics["perClass"][1].__setitem__(
                "recall", 0.81
            ),
            "class f1": lambda metrics: metrics["perClass"][1].__setitem__("f1", 0.81),
            "class support": lambda metrics: metrics["perClass"][1].__setitem__(
                "support", 24
            ),
            "no-sign false finals": lambda metrics: metrics["noSignBehavior"].__setitem__(
                "falseFinalCount", 0
            ),
            "accepted signs": lambda metrics: metrics["rejectionBehavior"].__setitem__(
                "acceptedSignCount", 138
            ),
            "unknown rejection": lambda metrics: metrics["rejectionBehavior"].__setitem__(
                "unknownRejectedCount", 23
            ),
        }

        for name, mutate in mutations.items():
            with self.subTest(metric=name):
                document = json.loads(json.dumps(source))
                mutate(document["evaluation"]["metrics"])
                with self.assertRaises(ContractError):
                    validate_contract_document(document, "model-metadata.schema.json")

    def test_thresholded_counts_are_not_inferred_from_argmax_matrix_columns(self):
        document = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        behavior = document["evaluation"]["metrics"]["rejectionBehavior"]
        behavior["acceptedSignCount"] = 138
        behavior["lowConfidenceRejectionCount"] = 7
        behavior["rejectionRate"] = 7 / 180

        validate_contract_document(document, "model-metadata.schema.json")

    def test_unknown_sample_count_must_equal_reject_label_support(self):
        document = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        behavior = document["evaluation"]["metrics"]["rejectionBehavior"]
        behavior["unknownSampleCount"] = 50
        behavior["unknownRejectedCount"] = 49
        behavior["unknownRejectionRate"] = 0.98
        behavior["unknownFalseFinalCount"] = 1
        behavior["unknownFalseFinalRate"] = 0.02

        with self.assertRaises(ContractError):
            validate_contract_document(document, "model-metadata.schema.json")

    def test_reviewed_label_ids_must_all_resolve_to_sign_outcomes(self):
        source = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json").read_text(
                encoding="utf-8"
            )
        )
        source["productionPromotion"] = {
            "status": "BLOCKED",
            "assessedAt": "2026-08-30T13:00:00Z",
            "blockingReasons": ["Regression probe must remain non-production."],
        }

        for non_sign_label in ("NO_SIGN", "OUT_OF_VOCABULARY"):
            with self.subTest(label=non_sign_label):
                document = json.loads(json.dumps(source))
                document["sgslReview"]["reviewedLabelIds"].append(non_sign_label)

                with self.assertRaises(ContractError):
                    validate_contract_document(document, "model-metadata.schema.json")

    def test_provenance_kind_and_evidence_cannot_be_relabelled_independently(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["provenance"]["kind"] = "NON_PRODUCTION_SYNTHETIC"

        with self.assertRaises(ContractError):
            validate_contract_document(document, "dataset-manifest.schema.json")

    def test_model_vocabulary_digest_binds_version_order_and_exact_captions(self):
        source = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json")
            .read_text(encoding="utf-8")
        )
        self.assertEqual(
            "bee237eb48aeb5d54320f75d821b9ed93de2d143a3a12c91776df4f3560a5b26",
            source["vocabularySha256"],
        )
        mutations = {
            "version": lambda value: value.__setitem__("vocabularyVersion", "1.0.1"),
            "digest": lambda value: value.__setitem__("vocabularySha256", "0" * 64),
            "caption": lambda value: value["labels"][1].__setitem__(
                "captionText", "hello"
            ),
            "label order": lambda value: (
                value["labels"][1].update(
                    id=value["labels"][2]["id"],
                    captionText=value["labels"][2]["captionText"],
                ),
                value["labels"][2].update(id="HELLO", captionText="Hello"),
            ),
            "review order": lambda value: value["sgslReview"]["reviewedLabelIds"]
            .__setitem__(slice(0, 2), list(reversed(value["sgslReview"]["reviewedLabelIds"][:2]))),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                document = json.loads(json.dumps(source))
                mutate(document)
                with self.assertRaises(ContractError):
                    validate_contract_document(document, "model-metadata.schema.json")

    def test_production_model_requires_complete_clean_source_provenance(self):
        source = json.loads(
            (contract_root() / "fixtures" / "model-metadata-production.valid.json")
            .read_text(encoding="utf-8")
        )
        cases = {
            "missing": lambda value: value.pop("sourceProvenance"),
            "dirty": lambda value: value["sourceProvenance"].update(
                dirty=True,
                trackedChangesSha256="a" * 64,
            ),
            "inconsistent": lambda value: value["sourceProvenance"].update(
                dirty=True,
            ),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                document = json.loads(json.dumps(source))
                mutate(document)
                with self.assertRaises(ContractError):
                    validate_contract_document(document, "model-metadata.schema.json")

    def test_split_assignment_digest_is_recomputed_from_canonical_assignments(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["splitPolicy"]["assignmentSha256"] = "0" * 64

        with self.assertRaisesRegex(ContractError, "assignmentDigestMatch"):
            validate_contract_document(document, "dataset-manifest.schema.json")

    def test_consent_must_not_postdate_capture(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["samples"][0]["consentAttestation"]["consentedAt"] = (
            "2026-08-28T10:00:01Z"
        )

        with self.assertRaisesRegex(ContractError, "consentBeforeCapture"):
            validate_contract_document(document, "dataset-manifest.schema.json")

    def test_retention_must_expire_after_capture_and_within_ninety_days(self):
        source = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        for retention_expires_at in (
            "2026-11-26T10:00:01Z",
            "2026-08-28T09:59:59Z",
        ):
            with self.subTest(retention_expires_at=retention_expires_at):
                document = json.loads(json.dumps(source))
                document["retentionExpiresAt"] = retention_expires_at
                with self.assertRaisesRegex(ContractError, "retentionWindow"):
                    validate_contract_document(document, "dataset-manifest.schema.json")

    def test_sign_samples_must_bind_to_the_reviewed_vocabulary(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["samples"][0]["labelId"] = "UNREVIEWED_SIGN"

        with self.assertRaisesRegex(ContractError, "reviewedLabelReference"):
            validate_contract_document(document, "dataset-manifest.schema.json")

    def test_reviewed_vocabulary_contains_unique_sign_labels_only(self):
        source = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        mutations = {
            "duplicate": lambda labels: labels.append(dict(labels[0])),
            "reserved": lambda labels: labels.append(
                {"labelId": "NO_SIGN", "gloss": "NO-SIGN", "captionText": "No sign"}
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                document = json.loads(json.dumps(source))
                mutate(document["reviewedLabels"])
                with self.assertRaises(ContractError):
                    validate_contract_document(document, "dataset-manifest.schema.json")

    def test_every_reviewed_vocabulary_label_requires_training_evidence(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["reviewedLabels"].append(
            {
                "labelId": "UNOBSERVED_SIGN",
                "gloss": "UNOBSERVED-SIGN",
                "captionText": "Reviewer-approved caption",
            }
        )

        with self.assertRaisesRegex(ContractError, "completeReviewedVocabulary"):
            validate_contract_document(document, "dataset-manifest.schema.json")

    def test_withdrawn_samples_are_semantically_rejected(self):
        document = json.loads(
            (contract_root() / "fixtures" / "dataset-manifest.valid.json").read_text(
                encoding="utf-8"
            )
        )
        document["samples"][0]["consentAttestation"]["withdrawalStatus"] = "WITHDRAWN"

        with self.assertRaisesRegex(ContractError, "activeWithdrawal"):
            validate_contract_document(document, "dataset-manifest.schema.json")


if __name__ == "__main__":
    unittest.main()
