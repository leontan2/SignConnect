from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from .contracts import ContractError, canonical_vocabulary_sha256, validate_contract_document
from .manifest import (
    ManifestError,
    load_manifest,
    require_genuine_sgsl,
    require_training_authorization,
)


_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_TIMESTAMP = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T"
    r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?Z$"
)
_MAX_EVIDENCE_BYTES = 10 * 1024 * 1024
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_EVIDENCE_PATH_FIELDS = {
    "datasetManifestPath",
    "vocabularyPath",
    "evaluationReportPath",
    "reviewReportPath",
    "javaParityReportPath",
    "browserReportPath",
    "parityVectorsPath",
}
_BUNDLE_ARTIFACT_FIELDS = {
    "datasetManifestSha256",
    "vocabularyArtifactSha256",
    "evaluationReportSha256",
    "reviewReportSha256",
    "javaParityReportSha256",
    "parityVectorsSha256",
    "browserReportSha256",
    "modelCardSha256",
}
_ROBUSTNESS_DIMENSIONS = {
    "lighting",
    "cameraDistance",
    "signingSpeed",
    "handedness",
    "occlusion",
    "behaviorScenario",
}
_REQUIRED_BEHAVIOR_SCENARIOS = {
    "INCOMPLETE_GESTURE",
    "HELD_SIGN",
    "REPEATED_SIGN",
}
_TRUSTED_EVIDENCE_FIELDS = {
    "datasetManifestSha256",
    "vocabularyArtifactSha256",
    "evaluationReportSha256",
    "reviewReportSha256",
    "javaParityReportSha256",
    "runtimeReportSha256",
    "parityVectorsSha256",
    "browserReportSha256",
    "modelCardSha256",
    "candidateEvidenceBundleSha256",
}


@dataclass(frozen=True)
class PromotionAssessment:
    """Result of applying independently recorded promotion evidence."""

    metadata: dict[str, Any]
    blockers: tuple[str, ...]

    @property
    def approved(self) -> bool:
        promotion = self.metadata.get("productionPromotion")
        return (
            not self.blockers
            and isinstance(promotion, Mapping)
            and promotion.get("status") == "APPROVED"
        )


@dataclass(frozen=True)
class _Artifact:
    document: Any
    sha256: str


def apply_promotion_evidence(
    metadata: Mapping[str, Any],
    onnx_path: str | Path,
    evidence: Mapping[str, Any],
) -> PromotionAssessment:
    """Approve only when every supplied evidence artifact is valid and bound.

    Inputs are never mutated. Error messages intentionally identify evidence
    roles rather than local paths, which may contain private participant data.
    """

    if not isinstance(metadata, Mapping):
        return PromotionAssessment(
            {},
            ("Exported model metadata does not pass its schema and semantic gates.",),
        )
    candidate = copy.deepcopy(dict(metadata))
    source_blockers = _source_provenance_blockers(candidate)
    try:
        validate_contract_document(candidate, "model-metadata.schema.json")
    except ContractError:
        return PromotionAssessment(
            candidate,
            source_blockers
            or ("Exported model metadata does not pass its schema and semantic gates.",),
        )

    try:
        artifact_digest = _sha256_file(Path(onnx_path))
    except (OSError, TypeError, ValueError):
        return PromotionAssessment(candidate, ("ONNX artifact could not be read.",))
    if artifact_digest != candidate["artifactSha256"]:
        return PromotionAssessment(
            candidate,
            ("ONNX artifact SHA-256 does not match exported metadata.",),
        )

    if not _valid_evidence_envelope(evidence):
        return PromotionAssessment(
            candidate,
            ("Promotion evidence must reference hash-validated artifacts.",),
        )

    assessed_at = evidence["assessedAt"]
    blockers: list[str] = list(source_blockers)
    if not _valid_timestamp(assessed_at):
        blockers.append("Promotion assessment timestamp is invalid.")
        assessed_at = candidate["productionPromotion"]["assessedAt"]

    artifacts: dict[str, _Artifact] = {}
    for role, field in (
        ("dataset manifest", "datasetManifestPath"),
        ("reviewed vocabulary", "vocabularyPath"),
        ("evaluation report", "evaluationReportPath"),
        ("SGSL review report", "reviewReportPath"),
        ("Java parity report", "javaParityReportPath"),
        ("frozen parity vectors", "parityVectorsPath"),
        ("browser acceptance report", "browserReportPath"),
    ):
        artifact, error = _read_json_artifact(evidence[field], role)
        if error is not None:
            blockers.append(error)
        elif artifact is not None:
            artifacts[field] = artifact

    release = evidence["releaseArtifacts"]
    model_card, model_card_error = _read_text_artifact(
        release["modelCardPath"], "model card"
    )
    if model_card_error is not None:
        blockers.append(model_card_error)
    bundle, bundle_error = _read_json_artifact(
        release["candidateEvidenceBundlePath"], "candidate evidence bundle"
    )
    if bundle_error is not None:
        blockers.append(bundle_error)

    if model_card is not None:
        if model_card.sha256 != release["modelCardSha256"]:
            blockers.append("Model-card SHA-256 does not match its artifact bytes.")
        blockers.extend(_model_card_blockers(candidate, model_card.document))
    if bundle is not None:
        if bundle.sha256 != release["candidateEvidenceBundleSha256"]:
            blockers.append(
                "Candidate-evidence-bundle SHA-256 does not match its artifact bytes."
            )
        blockers.extend(
            _candidate_bundle_blockers(candidate, bundle.document, artifacts, model_card)
        )

    registry_trusted = False
    trusted_registry, registry_error = _load_trusted_evidence_registry()
    if registry_error is not None:
        blockers.append(registry_error)
    elif trusted_registry is not None:
        trust_blockers = _trusted_evidence_blockers(
            candidate,
            trusted_registry,
            artifacts,
            model_card,
            bundle,
        )
        blockers.extend(trust_blockers)
        registry_trusted = not trust_blockers

    manifest = None
    manifest_authorized = False
    if "datasetManifestPath" in artifacts:
        try:
            manifest = load_manifest(evidence["datasetManifestPath"])
            require_genuine_sgsl(manifest)
            require_training_authorization(manifest)
        except (ManifestError, OSError, TypeError, ValueError):
            blockers.append(
                "Dataset manifest does not prove genuine, consented SGSL provenance."
            )
        else:
            manifest_authorized = True
            blockers.extend(_manifest_blockers(candidate, manifest))

    vocabulary = artifacts.get("vocabularyPath")
    if vocabulary is not None:
        blockers.extend(_vocabulary_blockers(candidate, vocabulary.document))

    evaluation = artifacts.get("evaluationReportPath")
    if evaluation is not None:
        blockers.extend(_evaluation_blockers(candidate, evaluation.document))

    review = artifacts.get("reviewReportPath")
    if review is not None:
        review_blockers = _review_blockers(candidate, review.document)
        blockers.extend(review_blockers)
        if registry_trusted and not review_blockers:
            candidate["sgslReview"] = {
                "status": "APPROVED",
                "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
                "reviewedLabelIds": list(review.document["reviewedLabelIds"]),
                "reviewArtifactSha256": review.sha256,
                "reviewedAt": review.document["reviewedAt"],
            }

    parity = artifacts.get("javaParityReportPath")
    parity_vectors = artifacts.get("parityVectorsPath")
    if parity_vectors is not None:
        blockers.extend(_parity_vector_blockers(candidate, parity_vectors.document))
    if parity is not None:
        parity_blockers = _java_parity_blockers(
            candidate,
            parity.document,
            None if parity_vectors is None else parity_vectors.sha256,
        )
        blockers.extend(parity_blockers)
        if registry_trusted and not parity_blockers:
            candidate["runtime"]["warmedP95LatencyMs"] = parity.document["runtime"][
                "warmedP95LatencyMs"
            ]

    browser = artifacts.get("browserReportPath")
    if browser is not None:
        blockers.extend(_browser_blockers(candidate, browser.document))

    manifest_is_bound = (
        registry_trusted
        and manifest_authorized
        and manifest is not None
        and not _manifest_blockers(candidate, manifest)
    )
    if manifest_is_bound:
        candidate["mockModel"] = False
        candidate["genuineSignLanguageData"] = True
        candidate["governance"] = {
            "allTrainingSamplesConsentVerified": True,
            "usageRightsVerified": True,
            "signerIndependentEvaluationVerified": True,
            "rawVideoOrImageDataIncluded": False,
        }

    blockers.extend(_promotion_gate_blockers(candidate))
    unique_blockers = tuple(dict.fromkeys(blockers))
    if unique_blockers:
        candidate["productionPromotion"] = {
            "status": "BLOCKED",
            "assessedAt": assessed_at,
            "blockingReasons": list(unique_blockers),
        }
        try:
            validate_contract_document(candidate, "model-metadata.schema.json")
        except ContractError:
            return PromotionAssessment(
                copy.deepcopy(dict(metadata)),
                ("Model metadata could not represent the blocked promotion result.",),
            )
        return PromotionAssessment(candidate, unique_blockers)

    candidate["productionPromotion"] = {
        "status": "APPROVED",
        "assessedAt": assessed_at,
        "blockingReasons": [],
    }
    try:
        validate_contract_document(candidate, "model-metadata.schema.json")
    except ContractError:
        blockers = ("Model metadata does not pass every production contract gate.",)
        candidate["productionPromotion"] = {
            "status": "BLOCKED",
            "assessedAt": assessed_at,
            "blockingReasons": list(blockers),
        }
        return PromotionAssessment(candidate, blockers)
    return PromotionAssessment(candidate, ())


def _valid_evidence_envelope(evidence: Any) -> bool:
    if not isinstance(evidence, Mapping) or set(evidence) != (
        _EVIDENCE_PATH_FIELDS | {"releaseArtifacts", "assessedAt"}
    ):
        return False
    if any(not isinstance(evidence[field], (str, Path)) for field in _EVIDENCE_PATH_FIELDS):
        return False
    release = evidence["releaseArtifacts"]
    return (
        isinstance(release, Mapping)
        and set(release)
        == {
            "modelCardPath",
            "modelCardSha256",
            "candidateEvidenceBundlePath",
            "candidateEvidenceBundleSha256",
        }
        and isinstance(release["modelCardPath"], (str, Path))
        and isinstance(release["candidateEvidenceBundlePath"], (str, Path))
        and _valid_sha256(release["modelCardSha256"])
        and _valid_sha256(release["candidateEvidenceBundleSha256"])
    )


def _load_trusted_evidence_registry() -> tuple[dict[str, Any] | None, str | None]:
    """Load the fixed repository trust root without path/env/caller overrides."""

    try:
        registry_path = next(
            candidate
            for parent in Path(__file__).resolve().parents
            if (
                candidate := parent
                / "contracts"
                / "sign-recognition-training"
                / "v1"
                / "trusted-promotion-evidence.json"
            ).is_file()
        )
        raw = registry_path.read_bytes()
    except (OSError, StopIteration):
        return None, "Trusted promotion evidence registry could not be read."
    if len(raw) > _MAX_EVIDENCE_BYTES:
        return None, "Trusted promotion evidence registry is malformed."
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "Trusted promotion evidence registry is malformed."
    if not _valid_trusted_registry(document):
        return None, "Trusted promotion evidence registry is malformed."
    return document, None


def _valid_trusted_registry(value: Any) -> bool:
    if (
        not isinstance(value, Mapping)
        or set(value) != {"schemaVersion", "authorities", "approvedEvidence"}
        or value["schemaVersion"] != 1
        or not isinstance(value["authorities"], list)
        or not isinstance(value["approvedEvidence"], list)
    ):
        return False
    authorities: dict[str, Mapping[str, Any]] = {}
    for authority in value["authorities"]:
        if (
            not isinstance(authority, Mapping)
            or set(authority) != {"authorityId", "role", "status"}
            or not isinstance(authority["authorityId"], str)
            or re.fullmatch(r"[a-z][a-z0-9-]{2,63}", authority["authorityId"])
            is None
            or authority["role"] not in {"SGSL_REVIEWER", "RELEASE_CI"}
            or authority["status"] not in {"ACTIVE", "REVOKED"}
            or authority["authorityId"] in authorities
        ):
            return False
        authorities[authority["authorityId"]] = authority
    for entry in value["approvedEvidence"]:
        if not _valid_trusted_registry_entry(entry, authorities):
            return False
    return True


def _valid_trusted_registry_entry(
    value: Any,
    authorities: Mapping[str, Mapping[str, Any]],
) -> bool:
    required = {
        "modelId",
        "modelVersion",
        "artifactSha256",
        "vocabularySha256",
        "sourceProvenanceSha256",
        "reviewAuthorityId",
        "ciAuthorityId",
        "approvedAt",
        "evidenceSha256",
    }
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or not isinstance(value["modelId"], str)
        or re.fullmatch(r"[a-z][a-z0-9-]{2,63}", value["modelId"]) is None
        or not isinstance(value["modelVersion"], str)
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value["modelVersion"])
        is None
        or not isinstance(value["reviewAuthorityId"], str)
        or not isinstance(value["ciAuthorityId"], str)
        or not all(
            _valid_sha256(value[field])
            for field in (
                "artifactSha256",
                "vocabularySha256",
                "sourceProvenanceSha256",
            )
        )
        or not _valid_timestamp(value["approvedAt"])
        or not isinstance(value["evidenceSha256"], Mapping)
        or set(value["evidenceSha256"]) != _TRUSTED_EVIDENCE_FIELDS
        or any(
            not _valid_sha256(digest)
            for digest in value["evidenceSha256"].values()
        )
    ):
        return False
    review = authorities.get(value["reviewAuthorityId"])
    ci = authorities.get(value["ciAuthorityId"])
    return (
        review is not None
        and review["role"] == "SGSL_REVIEWER"
        and review["status"] == "ACTIVE"
        and ci is not None
        and ci["role"] == "RELEASE_CI"
        and ci["status"] == "ACTIVE"
        and value["reviewAuthorityId"] != value["ciAuthorityId"]
    )


def _trusted_evidence_blockers(
    metadata: Mapping[str, Any],
    registry: Mapping[str, Any],
    artifacts: Mapping[str, _Artifact],
    model_card: _Artifact | None,
    bundle: _Artifact | None,
) -> tuple[str, ...]:
    actual = {
        "datasetManifestSha256": _artifact_digest(artifacts, "datasetManifestPath"),
        "vocabularyArtifactSha256": _artifact_digest(artifacts, "vocabularyPath"),
        "evaluationReportSha256": _artifact_digest(artifacts, "evaluationReportPath"),
        "reviewReportSha256": _artifact_digest(artifacts, "reviewReportPath"),
        "javaParityReportSha256": _artifact_digest(artifacts, "javaParityReportPath"),
        "runtimeReportSha256": _artifact_digest(artifacts, "javaParityReportPath"),
        "parityVectorsSha256": _artifact_digest(artifacts, "parityVectorsPath"),
        "browserReportSha256": _artifact_digest(artifacts, "browserReportPath"),
        "modelCardSha256": None if model_card is None else model_card.sha256,
        "candidateEvidenceBundleSha256": None if bundle is None else bundle.sha256,
    }
    expected_bindings = {
        "modelId": metadata["modelId"],
        "modelVersion": metadata["modelVersion"],
        "artifactSha256": metadata["artifactSha256"],
        "vocabularySha256": metadata["vocabularySha256"],
        "sourceProvenanceSha256": _canonical_sha256(metadata["sourceProvenance"]),
    }
    for entry in registry["approvedEvidence"]:
        if all(entry[field] == value for field, value in expected_bindings.items()) and all(
            actual[field] is not None
            and entry["evidenceSha256"][field] == actual[field]
            for field in _TRUSTED_EVIDENCE_FIELDS
        ):
            return ()
    return ("Evidence is not anchored by a trusted reviewer and release CI.",)


def _canonical_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()


def _read_json_artifact(value: Any, role: str) -> tuple[_Artifact | None, str | None]:
    raw, error = _read_bytes(value, role)
    if error is not None or raw is None:
        return None, error
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, f"The {role} is not valid UTF-8 JSON."
    if not isinstance(document, dict):
        return None, f"The {role} must contain a JSON object."
    return _Artifact(document, hashlib.sha256(raw).hexdigest()), None


def _read_text_artifact(value: Any, role: str) -> tuple[_Artifact | None, str | None]:
    raw, error = _read_bytes(value, role)
    if error is not None or raw is None:
        return None, error
    try:
        document = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None, f"The {role} is not valid UTF-8 text."
    return _Artifact(document, hashlib.sha256(raw).hexdigest()), None


def _read_bytes(value: Any, role: str) -> tuple[bytes | None, str | None]:
    if not isinstance(value, (str, Path)):
        return None, f"The {role} path is invalid."
    try:
        path = Path(value)
        if path.stat().st_size > _MAX_EVIDENCE_BYTES:
            return None, f"The {role} exceeds the evidence size limit."
        return path.read_bytes(), None
    except (OSError, TypeError, ValueError):
        return None, f"The {role} could not be read."


def _candidate_bundle_blockers(
    metadata: Mapping[str, Any],
    value: Any,
    artifacts: Mapping[str, _Artifact],
    model_card: _Artifact | None,
) -> tuple[str, ...]:
    required = {
        "schemaVersion",
        "modelId",
        "modelVersion",
        "modelArtifactSha256",
        "vocabularyVersion",
        "vocabularySha256",
        "assembledAt",
        "artifacts",
    }
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value["schemaVersion"] != 1
        or not _valid_timestamp(value["assembledAt"])
        or not isinstance(value["artifacts"], Mapping)
        or set(value["artifacts"]) != _BUNDLE_ARTIFACT_FIELDS
        or any(not _valid_sha256(item) for item in value["artifacts"].values())
    ):
        return ("Candidate evidence bundle is incomplete or malformed.",)
    blockers: list[str] = []
    bindings = {
        "modelId": metadata["modelId"],
        "modelVersion": metadata["modelVersion"],
        "modelArtifactSha256": metadata["artifactSha256"],
        "vocabularyVersion": metadata["vocabularyVersion"],
        "vocabularySha256": metadata["vocabularySha256"],
    }
    if any(value[field] != expected for field, expected in bindings.items()):
        blockers.append("Candidate evidence bundle does not bind the promoted model.")
    actual_hashes = {
        "datasetManifestSha256": _artifact_digest(artifacts, "datasetManifestPath"),
        "vocabularyArtifactSha256": _artifact_digest(artifacts, "vocabularyPath"),
        "evaluationReportSha256": _artifact_digest(artifacts, "evaluationReportPath"),
        "reviewReportSha256": _artifact_digest(artifacts, "reviewReportPath"),
        "javaParityReportSha256": _artifact_digest(artifacts, "javaParityReportPath"),
        "parityVectorsSha256": _artifact_digest(artifacts, "parityVectorsPath"),
        "browserReportSha256": _artifact_digest(artifacts, "browserReportPath"),
        "modelCardSha256": None if model_card is None else model_card.sha256,
    }
    for field, actual in actual_hashes.items():
        if actual is not None and value["artifacts"][field] != actual:
            blockers.append(f"Candidate evidence bundle does not bind the {field}.")
    return tuple(blockers)


def _artifact_digest(artifacts: Mapping[str, _Artifact], field: str) -> str | None:
    artifact = artifacts.get(field)
    return None if artifact is None else artifact.sha256


def _manifest_blockers(metadata: Mapping[str, Any], manifest: Any) -> tuple[str, ...]:
    blockers: list[str] = []
    if manifest.sha256 != metadata["trainingDataset"]["manifestSha256"]:
        blockers.append("Dataset manifest does not bind the trained model metadata.")
    if (
        manifest.dataset_id != metadata["trainingDataset"]["datasetId"]
        or manifest.dataset_version != metadata["trainingDataset"]["datasetVersion"]
        or manifest.dataset_licence != metadata["trainingDataset"]["licence"]
    ):
        blockers.append("Dataset identity or licence does not match model metadata.")
    protocol = metadata["evaluation"]["protocol"]
    if (
        manifest.split_assignment_sha256 != protocol["splitSha256"]
        or manifest.test_signer_count != protocol["testSignerCount"]
    ):
        blockers.append("Dataset manifest does not bind the locked evaluation split.")
    signer_count = len({sample.signer_id for sample in manifest.samples})
    test_signer_count = len(
        {sample.signer_id for sample in manifest.samples if sample.split_assignment == "TEST"}
    )
    if signer_count < 5:
        blockers.append("Dataset manifest has fewer than five signers.")
    if test_signer_count < 1:
        blockers.append("Dataset manifest has no independent locked-test signer.")
    if (
        manifest.target_language != metadata["targetLanguage"]
        or manifest.vocabulary_version != metadata["vocabularyVersion"]
        or manifest.vocabulary_sha256 != metadata["vocabularySha256"]
        or list(manifest.runtime_labels) != metadata["labels"]
    ):
        blockers.append("Dataset manifest vocabulary does not bind the promoted labels.")
    if (
        manifest.feature_layout_version != metadata["input"]["featureLayoutVersion"]
        or manifest.preprocessing_version != metadata["input"]["normalizationVersion"]
    ):
        blockers.append("Dataset preprocessing contract does not match model metadata.")
    return tuple(blockers)


def _vocabulary_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    expected = {
        "targetLanguage": metadata["targetLanguage"],
        "vocabularyVersion": metadata["vocabularyVersion"],
        "labels": metadata["labels"],
    }
    if value != expected:
        return ("Reviewed vocabulary artifact does not bind the promoted labels.",)
    digest = canonical_vocabulary_sha256(
        value["targetLanguage"], value["vocabularyVersion"], value["labels"]
    )
    if digest != metadata["vocabularySha256"]:
        return ("Reviewed vocabulary SHA-256 does not bind the promoted labels.",)
    return ()


def _evaluation_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    if value != metadata["evaluation"]:
        return ("Evaluation report does not exactly match model metadata.",)
    robustness = value.get("metrics", {}).get("robustnessSlices")
    if not isinstance(robustness, Mapping) or set(robustness) != _ROBUSTNESS_DIMENSIONS:
        return ("Evaluation report lacks every required robustness dimension.",)
    blockers: list[str] = []
    for dimension in sorted(_ROBUSTNESS_DIMENSIONS):
        slices = robustness[dimension]
        support = sum(
            item.get("support", 0)
            for item in slices
            if isinstance(item, Mapping)
            and isinstance(item.get("support"), int)
            and not isinstance(item.get("support"), bool)
        ) if isinstance(slices, list) else 0
        if not isinstance(slices, list) or not slices or support < 1:
            blockers.append(f"Robustness dimension {dimension} has no held-out support.")
    scenarios = {
        item.get("value")
        for item in robustness["behaviorScenario"]
        if isinstance(item, Mapping) and item.get("support", 0) > 0
    }
    missing = sorted(_REQUIRED_BEHAVIOR_SCENARIOS - scenarios)
    if missing:
        blockers.append(
            "Behavior robustness evidence lacks held-out support for: "
            + ", ".join(missing)
            + "."
        )
    return tuple(blockers)


def _review_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    required = {
        "schemaVersion", "modelId", "modelVersion", "artifactSha256",
        "targetLanguage", "vocabularyVersion", "vocabularySha256",
        "reviewerRole", "status", "reviewedLabelIds", "reviewedAt",
    }
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value["schemaVersion"] != 1
        or value["reviewerRole"] != "SGSL_FLUENT_DEAF_REVIEWER"
        or value["status"] != "APPROVED"
        or not _valid_timestamp(value["reviewedAt"])
        or not isinstance(value["reviewedLabelIds"], list)
    ):
        return ("SGSL review report is incomplete or malformed.",)
    bindings = {
        "modelId": metadata["modelId"], "modelVersion": metadata["modelVersion"],
        "artifactSha256": metadata["artifactSha256"],
        "targetLanguage": metadata["targetLanguage"],
        "vocabularyVersion": metadata["vocabularyVersion"],
        "vocabularySha256": metadata["vocabularySha256"],
    }
    blockers: list[str] = []
    if any(value[field] != expected for field, expected in bindings.items()):
        blockers.append("SGSL review report does not bind the promoted model vocabulary.")
    ordered_sign_labels = [
        label["id"] for label in metadata["labels"] if label["outcome"] == "SIGN"
    ]
    if value["reviewedLabelIds"] != ordered_sign_labels:
        blockers.append("Not every sign label has ordered SGSL-fluent Deaf review.")
    return tuple(blockers)


def _parity_vector_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    required = {
        "schemaVersion",
        "modelId",
        "modelVersion",
        "artifactSha256",
        "vocabularySha256",
        "cases",
    }
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value["schemaVersion"] != 1
        or not isinstance(value["cases"], list)
        or not value["cases"]
    ):
        return ("Frozen parity vectors are incomplete or malformed.",)
    bindings = {
        "modelId": metadata["modelId"],
        "modelVersion": metadata["modelVersion"],
        "artifactSha256": metadata["artifactSha256"],
        "vocabularySha256": metadata["vocabularySha256"],
    }
    blockers: list[str] = []
    if any(value[field] != expected for field, expected in bindings.items()):
        blockers.append("Frozen parity vectors do not bind the promoted model.")
    decisions = {label["id"] for label in metadata["labels"]}
    case_ids: set[str] = set()
    for item in value["cases"]:
        if (
            not isinstance(item, Mapping)
            or set(item)
            != {"caseId", "inputSha256", "expectedProbabilities", "expectedDecision"}
            or not isinstance(item["caseId"], str)
            or not item["caseId"]
            or item["caseId"] in case_ids
            or not _valid_sha256(item["inputSha256"])
            or not isinstance(item["expectedProbabilities"], list)
            or len(item["expectedProbabilities"]) != len(metadata["labels"])
            or any(
                not isinstance(probability, (int, float))
                or isinstance(probability, bool)
                or not math.isfinite(float(probability))
                or not 0 <= probability <= 1
                for probability in item["expectedProbabilities"]
            )
            or not math.isclose(
                sum(item["expectedProbabilities"]), 1.0, rel_tol=0.0, abs_tol=1e-6
            )
            or not isinstance(item["expectedDecision"], str)
            or item["expectedDecision"] not in decisions
        ):
            blockers.append("Frozen parity vectors contain an invalid test case.")
            break
        case_ids.add(item["caseId"])
    return tuple(blockers)


def _java_parity_blockers(
    metadata: Mapping[str, Any],
    value: Any,
    reference_vectors_sha256: str | None,
) -> tuple[str, ...]:
    required = {
        "schemaVersion", "modelId", "modelVersion", "artifactSha256",
        "vocabularySha256", "verifiedAt", "absoluteTolerance",
        "referenceVectorsSha256",
        "relativeTolerance", "probabilityMaxAbsoluteDifference",
        "probabilityMaxRelativeDifference", "decisionParityVerified", "runtime",
    }
    numeric = (
        "absoluteTolerance", "relativeTolerance",
        "probabilityMaxAbsoluteDifference", "probabilityMaxRelativeDifference",
    )
    runtime = value.get("runtime") if isinstance(value, Mapping) else None
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value["schemaVersion"] != 1
        or not _valid_timestamp(value["verifiedAt"])
        or not _valid_sha256(value["referenceVectorsSha256"])
        or any(not _finite_non_negative(value[field]) for field in numeric)
        or not isinstance(value["decisionParityVerified"], bool)
        or not isinstance(runtime, Mapping)
        or set(runtime) != {"engine", "warmedP95LatencyMs"}
        or runtime["engine"] != "ONNX_RUNTIME_JAVA"
        or not _finite_non_negative(runtime["warmedP95LatencyMs"])
    ):
        return ("Java parity report is incomplete or malformed.",)
    blockers: list[str] = []
    bindings = {
        "modelId": metadata["modelId"], "modelVersion": metadata["modelVersion"],
        "artifactSha256": metadata["artifactSha256"],
        "vocabularySha256": metadata["vocabularySha256"],
    }
    if any(value[field] != expected for field, expected in bindings.items()):
        blockers.append("Java parity report does not bind the promoted model.")
    if value["referenceVectorsSha256"] != reference_vectors_sha256:
        blockers.append("Java parity report does not bind the frozen reference vectors.")
    if value["absoluteTolerance"] <= 0 or value["absoluteTolerance"] > 0.00001:
        blockers.append("Java probability parity uses an invalid absolute tolerance.")
    if value["relativeTolerance"] <= 0 or value["relativeTolerance"] > 0.0001:
        blockers.append("Java probability parity uses an invalid relative tolerance.")
    if value["probabilityMaxAbsoluteDifference"] > value["absoluteTolerance"]:
        blockers.append("Java probability parity exceeds the absolute tolerance.")
    if value["probabilityMaxRelativeDifference"] > value["relativeTolerance"]:
        blockers.append("Java probability parity exceeds the relative tolerance.")
    if not value["decisionParityVerified"]:
        blockers.append("Java final decisions do not match the frozen reference vectors.")
    latency = runtime["warmedP95LatencyMs"]
    if latency <= 0:
        blockers.append("Java runtime report has no warmed p95 latency measurement.")
    elif latency > 500:
        blockers.append("Warmed ONNX Runtime Java CPU p95 latency exceeds 500 ms.")
    return tuple(blockers)


def _browser_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    required = {
        "schemaVersion", "modelId", "modelVersion", "artifactSha256",
        "vocabularySha256", "verifiedAt", "genuineModelMode",
        "supportedSignCount", "supportedSignPassed", "unknownSignCount",
        "unknownSignPassed", "repeatedSignCount", "repeatedSignPassed",
        "physicalCameraAccepted",
    }
    count_fields = ("supportedSignCount", "unknownSignCount", "repeatedSignCount")
    bool_fields = (
        "genuineModelMode", "supportedSignPassed", "unknownSignPassed",
        "repeatedSignPassed", "physicalCameraAccepted",
    )
    if (
        not isinstance(value, Mapping)
        or set(value) != required
        or value["schemaVersion"] != 1
        or not _valid_timestamp(value["verifiedAt"])
        or any(
            not isinstance(value[field], int)
            or isinstance(value[field], bool)
            or value[field] < 0
            for field in count_fields
        )
        or any(not isinstance(value[field], bool) for field in bool_fields)
    ):
        return ("Browser acceptance report is incomplete or malformed.",)
    blockers: list[str] = []
    bindings = {
        "modelId": metadata["modelId"], "modelVersion": metadata["modelVersion"],
        "artifactSha256": metadata["artifactSha256"],
        "vocabularySha256": metadata["vocabularySha256"],
    }
    if any(value[field] != expected for field, expected in bindings.items()):
        blockers.append("Browser acceptance report does not bind the promoted model.")
    if not value["genuineModelMode"]:
        blockers.append("Browser acceptance did not run in genuine-model mode.")
    if value["supportedSignCount"] < 5 or not value["supportedSignPassed"]:
        blockers.append("Browser acceptance lacks five passing supported signs.")
    if value["unknownSignCount"] < 1 or not value["unknownSignPassed"]:
        blockers.append("Browser acceptance lacks a passing genuine unknown-sign journey.")
    if value["repeatedSignCount"] < 1 or not value["repeatedSignPassed"]:
        blockers.append("Browser acceptance lacks a passing genuine repeated-sign journey.")
    if not value["physicalCameraAccepted"]:
        blockers.append("Physical-camera acceptance is absent.")
    return tuple(blockers)


def _model_card_blockers(metadata: Mapping[str, Any], value: Any) -> tuple[str, ...]:
    if not isinstance(value, str) or not value.strip():
        return ("Model card is empty.",)
    required_values = (
        metadata["modelId"], metadata["modelVersion"],
        metadata["artifactSha256"], metadata["vocabularySha256"],
    )
    if any(item not in value for item in required_values):
        return ("Model card does not bind the promoted model and vocabulary.",)
    return ()


def _promotion_gate_blockers(metadata: Mapping[str, Any]) -> tuple[str, ...]:
    blockers: list[str] = []
    if metadata["mockModel"]:
        blockers.append("Model is still marked as a mock.")
    if not metadata["genuineSignLanguageData"]:
        blockers.append("Genuine sign-language data provenance is not attested.")
    if metadata["architecture"]["family"] == "SYNTHETIC_FIXTURE":
        blockers.append("Synthetic fixture architecture cannot be promoted.")
    protocol = metadata["evaluation"]["protocol"]
    if protocol["splitStrategy"] != "SIGNER_INDEPENDENT":
        blockers.append("Evaluation is not signer-independent.")
    if protocol["signerOverlapCount"] != 0:
        blockers.append("Evaluation contains signer overlap.")
    if protocol["testSignerCount"] < 1:
        blockers.append("Evaluation has no held-out test signer.")
    metrics = metadata["evaluation"]["metrics"]
    if metrics["macroF1"] < 0.8:
        blockers.append("Evaluation macro F1 is below 0.80.")
    if metrics["falseFinalRate"] > 0.05:
        blockers.append("Evaluation false-final rate exceeds 0.05.")
    if metrics["sampleCount"] < 1:
        blockers.append("Evaluation has no locked-test samples.")
    no_sign = metrics["noSignBehavior"]
    rejection = metrics["rejectionBehavior"]
    if no_sign["sampleCount"] < 1:
        blockers.append("Evaluation has no NO_SIGN samples.")
    if no_sign["falseFinalRate"] > 0.05:
        blockers.append("NO_SIGN false-final rate exceeds 0.05.")
    if rejection["unknownSampleCount"] < 1:
        blockers.append("Evaluation has no unknown-sign samples.")
    if rejection["unknownRejectionRate"] is None or rejection["unknownRejectionRate"] < 0.95:
        blockers.append("Unknown-sign rejection rate is below 0.95.")
    if rejection["unknownFalseFinalRate"] is None or rejection["unknownFalseFinalRate"] > 0.05:
        blockers.append("Unknown-sign false-final rate exceeds 0.05.")
    if not metadata["onnx"]["parity"]["verified"]:
        blockers.append("PyTorch-to-ONNX parity is not verified.")
    latency = metadata["runtime"]["warmedP95LatencyMs"]
    if latency <= 0:
        blockers.append("Warmed ONNX Runtime Java CPU p95 latency is unmeasured.")
    elif latency > 500:
        blockers.append("Warmed ONNX Runtime Java CPU p95 latency exceeds 500 ms.")
    review = metadata["sgslReview"]
    if review["status"] != "APPROVED":
        blockers.append("SGSL-fluent Deaf review is not approved.")
    sign_labels = [label["id"] for label in metadata["labels"] if label["outcome"] == "SIGN"]
    if len(sign_labels) < 5:
        blockers.append("Reviewed vocabulary contains fewer than five sign labels.")
    if review["reviewedLabelIds"] != sign_labels:
        blockers.append("Not every sign label has SGSL-fluent Deaf review.")
    governance = metadata["governance"]
    if not governance["allTrainingSamplesConsentVerified"]:
        blockers.append("Training-sample consent is not verified.")
    if not governance["usageRightsVerified"]:
        blockers.append("Dataset usage rights are not verified.")
    if not governance["signerIndependentEvaluationVerified"]:
        blockers.append("Signer-independent evaluation governance is not verified.")
    if governance["rawVideoOrImageDataIncluded"]:
        blockers.append("Promoted metadata includes raw video or image data.")
    return tuple(blockers)


def _source_provenance_blockers(metadata: Mapping[str, Any]) -> tuple[str, ...]:
    """Require clean training-time source state; evidence cannot overwrite it."""

    value = metadata.get("sourceProvenance")
    required = {
        "commit",
        "dirty",
        "trackedChangesSha256",
        "untrackedFileCount",
        "untrackedStateSha256",
        "untrackedContentSha256",
    }
    if not isinstance(value, Mapping) or set(value) != required:
        return ("Training source provenance is missing or malformed.",)
    commit = value["commit"]
    if not isinstance(commit, str) or re.fullmatch(r"[a-f0-9]{40,64}", commit) is None:
        return ("Training source provenance has no valid source commit.",)
    if (
        value["dirty"] is not False
        or value["trackedChangesSha256"] != _EMPTY_SHA256
        or value["untrackedFileCount"] != 0
        or value["untrackedStateSha256"] != _EMPTY_SHA256
        or value["untrackedContentSha256"] != _EMPTY_SHA256
    ):
        return ("Training source provenance is not a clean, reproducible checkout.",)
    return ()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _finite_non_negative(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and value >= 0
    )


def _valid_sha256(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or _TIMESTAMP.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError:
        return False
    return True
