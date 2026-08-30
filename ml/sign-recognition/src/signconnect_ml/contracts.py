from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


class ContractError(ValueError):
    """Raised when a shared training-contract schema or semantic gate fails."""


def contract_root() -> Path:
    configured = os.environ.get("SIGNCONNECT_TRAINING_CONTRACT_ROOT")
    candidates = [Path(configured)] if configured else []
    candidates.extend(
        parent / "contracts" / "sign-recognition-training" / "v1"
        for origin in (Path(__file__).resolve(), Path.cwd().resolve())
        for parent in origin.parents
    )
    for candidate in candidates:
        if (candidate / "dataset-manifest.schema.json").is_file() and (
            candidate / "model-metadata.schema.json"
        ).is_file():
            return candidate.resolve()
    raise ContractError(
        "Could not locate contracts/sign-recognition-training/v1; set "
        "SIGNCONNECT_TRAINING_CONTRACT_ROOT"
    )


def validate_contract_document(document: dict[str, Any], schema_name: str) -> None:
    if schema_name not in {"dataset-manifest.schema.json", "model-metadata.schema.json"}:
        raise ValueError(f"unsupported schema: {schema_name}")
    schema = json.loads((contract_root() / schema_name).read_text(encoding="utf-8"))
    errors = sorted(
        Draft202012Validator(schema).iter_errors(document),
        key=lambda error: (tuple(str(part) for part in error.path), str(error.validator)),
    )
    if errors:
        details = "; ".join(
            f"{_json_pointer(error.path)} [keyword={error.validator or 'unknown'}]"
            for error in errors[:8]
        )
        raise ContractError(f"{schema_name} validation failed: {details}")
    semantic_errors = (
        _dataset_semantic_errors(document)
        if schema_name.startswith("dataset-")
        else _model_semantic_errors(document)
    )
    if semantic_errors:
        raise ContractError("; ".join(semantic_errors))


def _dataset_semantic_errors(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    sample_ids: set[str] = set()
    artifact_paths: set[str] = set()
    artifact_digests: set[str] = set()
    attestation_ids: set[str] = set()
    signer_splits: dict[str, str] = {}
    observed_splits: set[str] = set()
    test_signers: set[str] = set()
    for index, sample in enumerate(manifest.get("samples", [])):
        base = f"/samples/{index}"
        _unique(errors, sample_ids, sample["sampleId"], f"{base}/sampleId", "uniqueSampleId")
        _unique(
            errors,
            artifact_paths,
            sample["landmarkArtifact"]["path"],
            f"{base}/landmarkArtifact/path",
            "uniqueLandmarkPath",
        )
        _unique(
            errors,
            artifact_digests,
            sample["landmarkArtifact"]["sha256"],
            f"{base}/landmarkArtifact/sha256",
            "uniqueLandmarkDigest",
        )
        _unique(
            errors,
            attestation_ids,
            sample["consentAttestation"]["attestationId"],
            f"{base}/consentAttestation/attestationId",
            "uniqueConsentAttestation",
        )
        if sample["language"] != manifest["targetLanguage"]:
            errors.append(f"{base}/language [keyword=targetLanguageMatch]")
        if sample["featureLayoutVersion"] != manifest["featureLayoutVersion"]:
            errors.append(f"{base}/featureLayoutVersion [keyword=featureLayoutMatch]")
        signer = sample["signerId"]
        split = sample["splitAssignment"]
        if signer in signer_splits and signer_splits[signer] != split:
            errors.append(f"{base}/signerId [keyword=signerSplitDisjoint]")
        signer_splits[signer] = split
        observed_splits.add(split)
        if split == "TEST":
            test_signers.add(signer)
    for required in ("TRAIN", "VALIDATION", "TEST"):
        if required not in observed_splits:
            errors.append(f"/samples [keyword=required{required.title()}Split]")
    if len(test_signers) != manifest["splitPolicy"]["testSignerCount"]:
        errors.append("/splitPolicy/testSignerCount [keyword=uniqueTestSignerCount]")
    return errors


def _model_semantic_errors(metadata: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    label_entries = metadata.get("labels", [])
    labels = [label["id"] for label in label_entries]
    indices = [label["index"] for label in label_entries]
    if len(labels) != len(set(labels)):
        errors.append("/labels [keyword=uniqueLabelId]")
    if indices != list(range(len(indices))):
        errors.append("/labels [keyword=contiguousLabelIndex]")
    if metadata.get("output", {}).get("shape", [None, None])[1] != len(labels):
        errors.append("/output/shape/1 [keyword=labelCountMatch]")
    reviewable = {
        label["id"] for label in label_entries if label["outcome"] == "SIGN"
    }
    reviewed = set(metadata.get("sgslReview", {}).get("reviewedLabelIds", []))
    if not reviewed.issubset(reviewable):
        errors.append("/sgslReview/reviewedLabelIds [keyword=signLabelReference]")
    parity = metadata.get("onnx", {}).get("parity", {})
    if parity.get("maxAbsoluteDifference", 0) > parity.get("absoluteTolerance", float("inf")):
        errors.append("/onnx/parity/maxAbsoluteDifference [keyword=absoluteTolerance]")
    if metadata.get("productionPromotion", {}).get("status") == "APPROVED":
        if not reviewable.issubset(reviewed):
            errors.append("/sgslReview/reviewedLabelIds [keyword=completeProductionReview]")
        if metadata.get("architecture", {}).get("family") == "SYNTHETIC_FIXTURE":
            errors.append("/architecture/family [keyword=productionArchitecture]")
        if metadata.get("runtime", {}).get("warmedP95LatencyMs", 0) <= 0:
            errors.append("/runtime/warmedP95LatencyMs [keyword=measuredJavaLatency]")
    return errors


def _unique(
    errors: list[str],
    seen: set[str],
    value: str,
    pointer: str,
    keyword: str,
) -> None:
    if value in seen:
        errors.append(f"{pointer} [keyword={keyword}]")
    seen.add(value)


def _json_pointer(path) -> str:
    parts = [str(part).replace("~", "~0").replace("/", "~1") for part in path]
    return f"/{'/'.join(parts)}" if parts else "<root>"
