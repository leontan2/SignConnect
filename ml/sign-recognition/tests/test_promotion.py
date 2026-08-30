from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import signconnect_ml.promotion as promotion_module
from signconnect_ml.contracts import validate_contract_document
from signconnect_ml.manifest import load_manifest
from signconnect_ml.promotion import apply_promotion_evidence


ROOT = Path(__file__).resolve().parents[3]
CONTRACT_FIXTURES = ROOT / "contracts" / "sign-recognition-training" / "v1" / "fixtures"
TIMESTAMP = "2026-08-30T14:00:00Z"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _read_fixture(name: str) -> dict:
    return json.loads((CONTRACT_FIXTURES / name).read_text(encoding="utf-8"))


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _write_json(path: Path, value: object) -> None:
    path.write_bytes(_json_bytes(value))


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _assignment_sha(samples: list[dict]) -> str:
    assignments = [
        {
            "sampleId": sample["sampleId"],
            "signerId": sample["signerId"],
            "splitAssignment": sample["splitAssignment"],
        }
        for sample in sorted(samples, key=lambda item: item["sampleId"])
    ]
    return hashlib.sha256(_json_bytes(assignments)).hexdigest()


def _genuine_manifest(metadata: dict) -> dict:
    template = _read_fixture("dataset-manifest.valid.json")
    labels = [
        ("HELLO", "HELLO", "Hello"),
        ("THANK_YOU", "THANK-YOU", "Thank you"),
        ("YES", "YES", "Yes"),
        ("NO", "NO", "No"),
        ("HELP", "HELP", "Help"),
    ]
    manifest = {
        "schemaVersion": 1,
        "datasetId": "consented-sgsl-pilot",
        "datasetVersion": "1.0.0",
        "createdAt": "2026-08-28T08:00:00Z",
        "purposeVersion": "1.0.0",
        "consentNoticeVersion": "1.0.0",
        "vocabularyVersion": metadata["vocabularyVersion"],
        "reviewRecordId": "review_0000000000000001",
        "reviewedLabels": [
            {"labelId": label_id, "gloss": gloss, "captionText": caption}
            for label_id, gloss, caption in labels
        ],
        "retentionExpiresAt": "2026-11-25T10:00:00Z",
        "provenance": {
            "kind": "ATTESTED_SGSL_DATASET",
            "evidence": {
                "type": "DATASET_PROVENANCE_ATTESTATION",
                "recordId": "provenance_0000000000000001",
                "sha256": "4" * 64,
                "verifiedAt": "2026-08-28T08:30:00Z",
                "verifiedByRole": "PRIVACY_REVIEWER",
            },
        },
        "targetLanguage": metadata["targetLanguage"],
        "featureLayoutVersion": metadata["input"]["featureLayoutVersion"],
        "preprocessingVersion": metadata["input"]["normalizationVersion"],
        "datasetLicence": {
            "spdxExpression": "LicenseRef-SignConnect-Consent-v1",
            "commercialUseAllowed": False,
            "redistributionAllowed": False,
        },
        "splitPolicy": {
            "strategy": "SIGNER_INDEPENDENT",
            "locked": True,
            "assignmentSha256": "0" * 64,
            "testSignerCount": 2,
        },
        "samples": [],
    }
    label_ids = ["HELLO", "THANK_YOU", "YES", "NO", "HELP", "NO_SIGN", "OUT_OF_VOCABULARY"]
    splits = ["TRAIN", "TRAIN", "TRAIN", "VALIDATION", "VALIDATION", "TEST", "TEST"]
    for index, (label_id, split) in enumerate(zip(label_ids, splits), start=1):
        sample = copy.deepcopy(template["samples"][0])
        suffix = f"{index:016x}"
        sample.update(
            {
                "sampleId": f"sample_{suffix}",
                "signerId": f"sgn_{index:012x}",
                "labelId": label_id,
                "splitAssignment": split,
                "captureTimestamp": "2026-08-28T10:00:00Z",
            }
        )
        sample["landmarkArtifact"] = {
            "path": f"landmarks/{split.lower()}/sample_{suffix}.npz",
            "sha256": hashlib.sha256(f"landmark-{index}".encode()).hexdigest(),
            "mediaType": "application/x-npz",
        }
        sample["consentAttestation"] = {
            "status": "VERIFIED",
            "attestationId": f"consent_{suffix}",
            "consentedAt": "2026-08-28T09:55:00Z",
            "permittedUses": ["MODEL_TRAINING", "MODEL_EVALUATION"],
            "withdrawalStatus": "ACTIVE",
        }
        sample["usageRightsAttestation"] = {
            "status": "VERIFIED",
            "basis": "PARTICIPANT_CONSENT",
            "sourceRecordId": f"rights_{suffix}",
            "attestedAt": "2026-08-28T09:56:00Z",
            "attestedByRole": "PRIVACY_REVIEWER",
            "restrictions": [],
        }
        manifest["samples"].append(sample)
    manifest["splitPolicy"]["assignmentSha256"] = _assignment_sha(manifest["samples"])
    return manifest


def _blocked_metadata(onnx_path: Path) -> dict:
    metadata = _read_fixture("model-metadata-production.valid.json")
    metadata["modelId"] = "signconnect-tcn-candidate"
    metadata["modelVersion"] = "0.1.0-candidate"
    metadata["artifactSha256"] = _sha(onnx_path)
    metadata["mockModel"] = True
    metadata["genuineSignLanguageData"] = False
    metadata["runtime"]["warmedP95LatencyMs"] = 0.0
    metadata["sgslReview"] = {
        "status": "PENDING",
        "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
        "reviewedLabelIds": [],
        "reviewArtifactSha256": None,
        "reviewedAt": None,
    }
    metadata["governance"] = {
        "allTrainingSamplesConsentVerified": False,
        "usageRightsVerified": False,
        "signerIndependentEvaluationVerified": False,
        "rawVideoOrImageDataIncluded": False,
    }
    metadata["productionPromotion"] = {
        "status": "BLOCKED",
        "assessedAt": "2026-08-30T13:00:00Z",
        "blockingReasons": ["External evidence has not been applied."],
    }
    slice_template = {
        "accuracy": 0.9,
        "macroF1": 0.9,
        "falseFinalRate": 0.0,
        "rejectionRate": 0.1,
    }
    metadata["evaluation"]["metrics"]["robustnessSlices"]["behaviorScenario"] = [
        {"value": value, "support": support, **slice_template}
        for value, support in (
            ("ISOLATED_SIGN", 45),
            ("INCOMPLETE_GESTURE", 45),
            ("HELD_SIGN", 45),
            ("REPEATED_SIGN", 45),
        )
    ]
    return metadata


def _build_bundle(metadata: dict, paths: dict[str, Path]) -> dict:
    return {
        "schemaVersion": 1,
        "modelId": metadata["modelId"],
        "modelVersion": metadata["modelVersion"],
        "modelArtifactSha256": metadata["artifactSha256"],
        "vocabularyVersion": metadata["vocabularyVersion"],
        "vocabularySha256": metadata["vocabularySha256"],
        "assembledAt": TIMESTAMP,
        "artifacts": {
            "datasetManifestSha256": _sha(paths["datasetManifestPath"]),
            "vocabularyArtifactSha256": _sha(paths["vocabularyPath"]),
            "evaluationReportSha256": _sha(paths["evaluationReportPath"]),
            "reviewReportSha256": _sha(paths["reviewReportPath"]),
            "javaParityReportSha256": _sha(paths["javaParityReportPath"]),
            "parityVectorsSha256": _sha(paths["parityVectorsPath"]),
            "browserReportSha256": _sha(paths["browserReportPath"]),
            "modelCardSha256": _sha(paths["modelCardPath"]),
        },
    }


def _refresh_bundle(metadata: dict, evidence: dict) -> None:
    paths = {
        **{field: Path(evidence[field]) for field in evidence if field.endswith("Path")},
        "modelCardPath": Path(evidence["releaseArtifacts"]["modelCardPath"]),
    }
    bundle_path = Path(evidence["releaseArtifacts"]["candidateEvidenceBundlePath"])
    _write_json(bundle_path, _build_bundle(metadata, paths))
    evidence["releaseArtifacts"]["modelCardSha256"] = _sha(paths["modelCardPath"])
    evidence["releaseArtifacts"]["candidateEvidenceBundleSha256"] = _sha(bundle_path)


def _trusted_registry(metadata: dict, evidence: dict) -> dict:
    source_sha256 = hashlib.sha256(
        _json_bytes(metadata["sourceProvenance"])
    ).hexdigest()
    java_sha256 = _sha(Path(evidence["javaParityReportPath"]))
    return {
        "schemaVersion": 1,
        "authorities": [
            {
                "authorityId": "sgsl-review-board",
                "role": "SGSL_REVIEWER",
                "status": "ACTIVE",
            },
            {
                "authorityId": "signconnect-release-ci",
                "role": "RELEASE_CI",
                "status": "ACTIVE",
            },
        ],
        "approvedEvidence": [
            {
                "modelId": metadata["modelId"],
                "modelVersion": metadata["modelVersion"],
                "artifactSha256": metadata["artifactSha256"],
                "vocabularySha256": metadata["vocabularySha256"],
                "sourceProvenanceSha256": source_sha256,
                "reviewAuthorityId": "sgsl-review-board",
                "ciAuthorityId": "signconnect-release-ci",
                "approvedAt": TIMESTAMP,
                "evidenceSha256": {
                    "datasetManifestSha256": _sha(
                        Path(evidence["datasetManifestPath"])
                    ),
                    "vocabularyArtifactSha256": _sha(
                        Path(evidence["vocabularyPath"])
                    ),
                    "evaluationReportSha256": _sha(
                        Path(evidence["evaluationReportPath"])
                    ),
                    "reviewReportSha256": _sha(Path(evidence["reviewReportPath"])),
                    "javaParityReportSha256": java_sha256,
                    "runtimeReportSha256": java_sha256,
                    "parityVectorsSha256": _sha(
                        Path(evidence["parityVectorsPath"])
                    ),
                    "browserReportSha256": _sha(
                        Path(evidence["browserReportPath"])
                    ),
                    "modelCardSha256": _sha(
                        Path(evidence["releaseArtifacts"]["modelCardPath"])
                    ),
                    "candidateEvidenceBundleSha256": _sha(
                        Path(
                            evidence["releaseArtifacts"][
                                "candidateEvidenceBundlePath"
                            ]
                        )
                    ),
                },
            }
        ],
    }


def _materialize(tmp_path: Path) -> tuple[dict, Path, dict]:
    onnx_path = tmp_path / "candidate.onnx"
    onnx_path.write_bytes(b"real onnx candidate bytes")
    metadata = _blocked_metadata(onnx_path)

    manifest_path = tmp_path / "dataset-manifest.json"
    _write_json(manifest_path, _genuine_manifest(metadata))
    manifest = load_manifest(manifest_path)
    metadata["trainingDataset"] = {
        "datasetId": manifest.dataset_id,
        "datasetVersion": manifest.dataset_version,
        "manifestPath": "manifests/consented-sgsl-pilot.json",
        "manifestSha256": manifest.sha256,
        "licence": manifest.dataset_licence,
    }
    metadata["evaluation"]["protocol"]["splitSha256"] = manifest.split_assignment_sha256
    metadata["evaluation"]["protocol"]["testSignerCount"] = manifest.test_signer_count

    paths = {
        "datasetManifestPath": manifest_path,
        "vocabularyPath": tmp_path / "vocabulary.json",
        "evaluationReportPath": tmp_path / "evaluation.json",
        "reviewReportPath": tmp_path / "review.json",
        "javaParityReportPath": tmp_path / "java-parity.json",
        "parityVectorsPath": tmp_path / "parity-vectors.json",
        "browserReportPath": tmp_path / "browser.json",
        "modelCardPath": tmp_path / "MODEL_CARD.md",
    }
    _write_json(
        paths["vocabularyPath"],
        {
            "targetLanguage": metadata["targetLanguage"],
            "vocabularyVersion": metadata["vocabularyVersion"],
            "labels": metadata["labels"],
        },
    )
    _write_json(paths["evaluationReportPath"], metadata["evaluation"])
    sign_labels = [label["id"] for label in metadata["labels"] if label["outcome"] == "SIGN"]
    _write_json(
        paths["reviewReportPath"],
        {
            "schemaVersion": 1,
            "modelId": metadata["modelId"],
            "modelVersion": metadata["modelVersion"],
            "artifactSha256": metadata["artifactSha256"],
            "targetLanguage": metadata["targetLanguage"],
            "vocabularyVersion": metadata["vocabularyVersion"],
            "vocabularySha256": metadata["vocabularySha256"],
            "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
            "status": "APPROVED",
            "reviewedLabelIds": sign_labels,
            "reviewedAt": TIMESTAMP,
        },
    )
    _write_json(
        paths["parityVectorsPath"],
        {
            "schemaVersion": 1,
            "modelId": metadata["modelId"],
            "modelVersion": metadata["modelVersion"],
            "artifactSha256": metadata["artifactSha256"],
            "vocabularySha256": metadata["vocabularySha256"],
            "cases": [
                {
                    "caseId": "supported-hello",
                    "inputSha256": "9" * 64,
                    "expectedProbabilities": [0.01, 0.94, 0.01, 0.01, 0.01, 0.01, 0.01],
                    "expectedDecision": "HELLO",
                }
            ],
        },
    )
    _write_json(
        paths["javaParityReportPath"],
        {
            "schemaVersion": 1,
            "modelId": metadata["modelId"],
            "modelVersion": metadata["modelVersion"],
            "artifactSha256": metadata["artifactSha256"],
            "vocabularySha256": metadata["vocabularySha256"],
            "referenceVectorsSha256": _sha(paths["parityVectorsPath"]),
            "verifiedAt": TIMESTAMP,
            "absoluteTolerance": 0.00001,
            "relativeTolerance": 0.0001,
            "probabilityMaxAbsoluteDifference": 0.000001,
            "probabilityMaxRelativeDifference": 0.00001,
            "decisionParityVerified": True,
            "runtime": {"engine": "ONNX_RUNTIME_JAVA", "warmedP95LatencyMs": 120.5},
        },
    )
    _write_json(
        paths["browserReportPath"],
        {
            "schemaVersion": 1,
            "modelId": metadata["modelId"],
            "modelVersion": metadata["modelVersion"],
            "artifactSha256": metadata["artifactSha256"],
            "vocabularySha256": metadata["vocabularySha256"],
            "verifiedAt": TIMESTAMP,
            "genuineModelMode": True,
            "supportedSignCount": 5,
            "supportedSignPassed": True,
            "unknownSignCount": 1,
            "unknownSignPassed": True,
            "repeatedSignCount": 1,
            "repeatedSignPassed": True,
            "physicalCameraAccepted": True,
        },
    )
    paths["modelCardPath"].write_text(
        "\n".join(
            (
                "# SignConnect model card",
                metadata["modelId"],
                metadata["modelVersion"],
                metadata["artifactSha256"],
                metadata["vocabularySha256"],
            )
        ),
        encoding="utf-8",
    )
    bundle_path = tmp_path / "candidate-evidence-bundle.json"
    _write_json(bundle_path, _build_bundle(metadata, paths))
    evidence = {
        **{field: path for field, path in paths.items() if field != "modelCardPath"},
        "releaseArtifacts": {
            "modelCardPath": paths["modelCardPath"],
            "modelCardSha256": _sha(paths["modelCardPath"]),
            "candidateEvidenceBundlePath": bundle_path,
            "candidateEvidenceBundleSha256": _sha(bundle_path),
        },
        "assessedAt": TIMESTAMP,
    }
    validate_contract_document(metadata, "model-metadata.schema.json")
    return metadata, onnx_path, evidence


def test_repository_anchored_evidence_approves_via_private_test_seam_without_mutation(
    tmp_path: Path,
):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    original_metadata = copy.deepcopy(metadata)
    original_evidence = copy.deepcopy(evidence)
    registry = _trusted_registry(metadata, evidence)

    with patch.object(
        promotion_module,
        "_load_trusted_evidence_registry",
        return_value=(registry, None),
    ):
        result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.approved is True
    assert result.blockers == ()
    assert result.metadata["mockModel"] is False
    assert result.metadata["genuineSignLanguageData"] is True
    assert result.metadata["runtime"]["warmedP95LatencyMs"] == 120.5
    assert result.metadata["sgslReview"]["reviewArtifactSha256"] == _sha(
        Path(evidence["reviewReportPath"])
    )
    assert result.metadata["productionPromotion"] == {
        "status": "APPROVED",
        "assessedAt": TIMESTAMP,
        "blockingReasons": [],
    }
    assert metadata == original_metadata
    assert evidence == original_evidence


def test_self_asserted_claims_are_not_trusted_promotion_evidence(tmp_path: Path):
    metadata, onnx_path, _ = _materialize(tmp_path)
    claims = {
        "mockModel": False,
        "genuineSignLanguageData": True,
        "governance": {"allTrainingSamplesConsentVerified": True},
        "assessedAt": TIMESTAMP,
    }

    result = apply_promotion_evidence(metadata, onnx_path, claims)

    assert result.approved is False
    assert result.blockers == ("Promotion evidence must reference hash-validated artifacts.",)


def test_self_consistent_fabricated_artifacts_need_a_repository_trust_anchor(
    tmp_path: Path,
):
    metadata, onnx_path, evidence = _materialize(tmp_path)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.approved is False
    assert "Evidence is not anchored by a trusted reviewer and release CI." in (
        result.blockers
    )
    assert result.metadata["mockModel"] is True
    assert result.metadata["genuineSignLanguageData"] is False
    assert result.metadata["sgslReview"]["status"] == "PENDING"
    assert result.metadata["runtime"]["warmedP95LatencyMs"] == 0.0


def test_trusted_registry_requires_every_exact_evidence_digest(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    registry = _trusted_registry(metadata, evidence)
    registry["approvedEvidence"][0]["evidenceSha256"][
        "browserReportSha256"
    ] = "a" * 64

    with patch.object(
        promotion_module,
        "_load_trusted_evidence_registry",
        return_value=(registry, None),
    ):
        result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.approved is False
    assert "Evidence is not anchored by a trusted reviewer and release CI." in (
        result.blockers
    )


def test_malformed_or_revoked_registry_fails_closed(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    registry = _trusted_registry(metadata, evidence)
    registry["authorities"][0]["status"] = "REVOKED"

    assert promotion_module._valid_trusted_registry(registry) is False
    with patch.object(
        promotion_module,
        "_load_trusted_evidence_registry",
        return_value=(None, "Trusted promotion evidence registry is malformed."),
    ):
        result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.approved is False
    assert "Trusted promotion evidence registry is malformed." in result.blockers

    malformed = _trusted_registry(metadata, evidence)
    malformed["approvedEvidence"][0]["reviewAuthorityId"] = []
    assert promotion_module._valid_trusted_registry(malformed) is False


def test_tampered_report_bytes_are_detected_by_candidate_bundle(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    review_path = Path(evidence["reviewReportPath"])
    review = json.loads(review_path.read_text(encoding="utf-8"))
    review["reviewedAt"] = "2026-08-30T14:01:00Z"
    _write_json(review_path, review)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Candidate evidence bundle does not bind the reviewReportSha256." in result.blockers
    assert result.approved is False


def test_manifest_is_validated_for_genuine_provenance_consent_and_model_binding(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    manifest_path = Path(evidence["datasetManifestPath"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["provenance"] = {
        "kind": "NON_PRODUCTION_SYNTHETIC",
        "evidence": {
            "type": "SYNTHETIC_GENERATOR",
            "generatorId": "signconnect-ml-generate-synthetic",
            "generatorVersion": "1.0.0",
            "seed": 1,
        },
    }
    _write_json(manifest_path, manifest)
    metadata["trainingDataset"]["manifestSha256"] = _sha(manifest_path)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Dataset manifest does not prove genuine, consented SGSL provenance." in result.blockers
    assert result.metadata["mockModel"] is True
    assert result.metadata["governance"]["allTrainingSamplesConsentVerified"] is False


def test_manifest_must_prove_at_least_five_signers(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    manifest_path = Path(evidence["datasetManifestPath"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    signer_by_split = {
        "TRAIN": "sgn_000000000001",
        "VALIDATION": "sgn_000000000002",
        "TEST": "sgn_000000000003",
    }
    for sample in manifest["samples"]:
        sample["signerId"] = signer_by_split[sample["splitAssignment"]]
    manifest["splitPolicy"]["testSignerCount"] = 1
    manifest["splitPolicy"]["assignmentSha256"] = _assignment_sha(manifest["samples"])
    _write_json(manifest_path, manifest)
    metadata["trainingDataset"]["manifestSha256"] = _sha(manifest_path)
    metadata["evaluation"]["protocol"]["splitSha256"] = manifest["splitPolicy"]["assignmentSha256"]
    metadata["evaluation"]["protocol"]["testSignerCount"] = 1
    _write_json(Path(evidence["evaluationReportPath"]), metadata["evaluation"])
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Dataset manifest has fewer than five signers." in result.blockers


def test_review_report_must_bind_model_vocabulary_and_all_ordered_labels(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    review_path = Path(evidence["reviewReportPath"])
    review = json.loads(review_path.read_text(encoding="utf-8"))
    review["vocabularySha256"] = "a" * 64
    review["reviewedLabelIds"].reverse()
    _write_json(review_path, review)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert set(result.blockers) >= {
        "SGSL review report does not bind the promoted model vocabulary.",
        "Not every sign label has ordered SGSL-fluent Deaf review.",
    }
    assert result.metadata["sgslReview"]["status"] == "PENDING"


def test_java_report_must_bind_model_and_pass_numeric_and_decision_parity(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    parity_path = Path(evidence["javaParityReportPath"])
    parity = json.loads(parity_path.read_text(encoding="utf-8"))
    parity["artifactSha256"] = "b" * 64
    parity["probabilityMaxAbsoluteDifference"] = 0.00002
    parity["decisionParityVerified"] = False
    _write_json(parity_path, parity)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert set(result.blockers) >= {
        "Java parity report does not bind the promoted model.",
        "Java probability parity exceeds the absolute tolerance.",
        "Java final decisions do not match the frozen reference vectors.",
    }
    assert result.metadata["runtime"]["warmedP95LatencyMs"] == 0.0


def test_java_report_must_bind_real_frozen_vector_bytes(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    vectors_path = Path(evidence["parityVectorsPath"])
    vectors = json.loads(vectors_path.read_text(encoding="utf-8"))
    vectors["cases"][0]["expectedDecision"] = "NO"
    _write_json(vectors_path, vectors)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Java parity report does not bind the frozen reference vectors." in result.blockers


def test_robustness_is_derived_from_exact_evaluation_slices(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    behavior = metadata["evaluation"]["metrics"]["robustnessSlices"]["behaviorScenario"]
    behavior[:] = [
        {
            "value": "ISOLATED_SIGN",
            "support": 180,
            **{
                key: behavior[0][key]
                for key in (
                    "accuracy",
                    "macroF1",
                    "falseFinalRate",
                    "rejectionRate",
                )
            },
        }
    ]
    _write_json(Path(evidence["evaluationReportPath"]), metadata["evaluation"])
    _refresh_bundle(metadata, evidence)
    validate_contract_document(metadata, "model-metadata.schema.json")

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert (
        "Behavior robustness evidence lacks held-out support for: "
        "HELD_SIGN, INCOMPLETE_GESTURE, REPEATED_SIGN."
    ) in result.blockers


def test_evaluation_report_must_exactly_match_exported_metadata(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    report_path = Path(evidence["evaluationReportPath"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["metrics"]["macroF1"] = 0.99
    _write_json(report_path, report)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Evaluation report does not exactly match model metadata." in result.blockers


def test_browser_report_must_bind_genuine_journeys_and_physical_camera(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    browser_path = Path(evidence["browserReportPath"])
    browser = json.loads(browser_path.read_text(encoding="utf-8"))
    browser.update(
        {
            "artifactSha256": "c" * 64,
            "genuineModelMode": False,
            "supportedSignCount": 4,
            "unknownSignPassed": False,
            "repeatedSignPassed": False,
            "physicalCameraAccepted": False,
        }
    )
    _write_json(browser_path, browser)
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert set(result.blockers) >= {
        "Browser acceptance report does not bind the promoted model.",
        "Browser acceptance did not run in genuine-model mode.",
        "Browser acceptance lacks five passing supported signs.",
        "Browser acceptance lacks a passing genuine unknown-sign journey.",
        "Browser acceptance lacks a passing genuine repeated-sign journey.",
        "Physical-camera acceptance is absent.",
    }


def test_model_card_is_read_hashed_and_bound_to_model(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    card_path = Path(evidence["releaseArtifacts"]["modelCardPath"])
    card_path.write_text("# Unbound model card\n", encoding="utf-8")
    _refresh_bundle(metadata, evidence)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Model card does not bind the promoted model and vocabulary." in result.blockers


def test_candidate_bundle_itself_must_bind_model_and_vocabulary(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    bundle_path = Path(evidence["releaseArtifacts"]["candidateEvidenceBundlePath"])
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    bundle["modelArtifactSha256"] = "e" * 64
    bundle["vocabularySha256"] = "f" * 64
    _write_json(bundle_path, bundle)
    evidence["releaseArtifacts"]["candidateEvidenceBundleSha256"] = _sha(bundle_path)

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "Candidate evidence bundle does not bind the promoted model." in result.blockers


def test_final_release_hash_is_not_a_candidate_bundle_substitute(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    release = evidence["releaseArtifacts"]
    release["releaseBundleSha256"] = release.pop("candidateEvidenceBundleSha256")

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.blockers == ("Promotion evidence must reference hash-validated artifacts.",)


def test_source_provenance_is_not_overwritable_and_must_be_clean(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    metadata["sourceProvenance"].update(
        {"dirty": True, "trackedChangesSha256": "d" * 64}
    )
    validate_contract_document(metadata, "model-metadata.schema.json")

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.approved is False
    assert "Training source provenance is not a clean, reproducible checkout." in result.blockers
    assert result.metadata["sourceProvenance"] == metadata["sourceProvenance"]


def test_missing_source_provenance_has_an_explicit_fail_closed_blocker(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    del metadata["sourceProvenance"]

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.blockers == ("Training source provenance is missing or malformed.",)


def test_unavailable_source_provenance_cannot_be_promoted(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    metadata["sourceProvenance"] = {
        "commit": None,
        "dirty": None,
        "trackedChangesSha256": None,
        "untrackedFileCount": None,
        "untrackedStateSha256": None,
        "untrackedContentSha256": None,
    }
    validate_contract_document(metadata, "model-metadata.schema.json")

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert result.blockers[0] == "Training source provenance has no valid source commit."


def test_private_evidence_paths_are_never_leaked_in_blockers(tmp_path: Path):
    metadata, onnx_path, evidence = _materialize(tmp_path)
    private_name = "participant-secret-42"
    evidence["reviewReportPath"] = tmp_path / private_name / "missing.json"

    result = apply_promotion_evidence(metadata, onnx_path, evidence)

    assert "The SGSL review report could not be read." in result.blockers
    assert all(
        private_name not in blocker and str(tmp_path) not in blocker
        for blocker in result.blockers
    )


def test_invalid_source_metadata_and_missing_onnx_fail_closed(tmp_path: Path):
    invalid = apply_promotion_evidence({}, tmp_path / "missing.onnx", {})
    assert invalid.blockers == ("Training source provenance is missing or malformed.",)

    metadata, _, evidence = _materialize(tmp_path)
    missing = apply_promotion_evidence(metadata, tmp_path / "not-there.onnx", evidence)
    assert missing.blockers == ("ONNX artifact could not be read.",)


def test_non_mapping_metadata_is_reported_not_raised(tmp_path: Path):
    result = apply_promotion_evidence(  # type: ignore[arg-type]
        None, tmp_path / "missing.onnx", {}
    )

    assert result.metadata == {}
    assert result.blockers == (
        "Exported model metadata does not pass its schema and semantic gates.",
    )
