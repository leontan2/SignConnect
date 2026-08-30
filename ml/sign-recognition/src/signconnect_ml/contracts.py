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
    _evaluation_metric_errors(metadata, label_entries, errors)
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


def _evaluation_metric_errors(
    metadata: dict[str, Any],
    labels: list[dict[str, Any]],
    errors: list[str],
) -> None:
    """Bind reported classification summaries to their authoritative matrix.

    Thresholded decisions cannot be reconstructed from an argmax confusion
    matrix. Their counts are therefore checked for internal arithmetic and are
    bound to the deployed threshold, but are deliberately not inferred from
    matrix columns.
    """
    metrics = metadata.get("evaluation", {}).get("metrics", {})
    per_class = metrics.get("perClass")
    matrix = metrics.get("confusionMatrix")

    if per_class is not None:
        if len(per_class) != len(labels):
            errors.append("/evaluation/metrics/perClass [keyword=labelCountMatch]")
        for position, item in enumerate(per_class):
            if position >= len(labels):
                break
            if item["index"] != position or item["labelId"] != labels[position]["id"]:
                errors.append(
                    f"/evaluation/metrics/perClass/{position} [keyword=indexedLabelMatch]"
                )

    if matrix is not None:
        label_ids = [label["id"] for label in labels]
        rows = matrix["rows"]
        if matrix["labelOrder"] != label_ids:
            errors.append(
                "/evaluation/metrics/confusionMatrix/labelOrder [keyword=labelOrderMatch]"
            )
        if len(rows) != len(labels) or any(len(row) != len(labels) for row in rows):
            errors.append(
                "/evaluation/metrics/confusionMatrix/rows [keyword=squareLabelMatrix]"
            )
        else:
            _matrix_derived_metric_errors(metrics, labels, rows, errors)

    no_sign = metrics.get("noSignBehavior")
    if no_sign is not None:
        expected_rate = (
            0.0
            if no_sign["sampleCount"] == 0
            else no_sign["falseFinalCount"] / no_sign["sampleCount"]
        )
        if no_sign["falseFinalCount"] > no_sign["sampleCount"]:
            errors.append(
                "/evaluation/metrics/noSignBehavior/falseFinalCount "
                "[keyword=boundedBySampleCount]"
            )
        if not _same_rate(no_sign["falseFinalRate"], expected_rate):
            errors.append(
                "/evaluation/metrics/noSignBehavior/falseFinalRate [keyword=countDerivedRate]"
            )
        if not _same_rate(metrics["falseFinalRate"], no_sign["falseFinalRate"]):
            errors.append(
                "/evaluation/metrics/falseFinalRate [keyword=noSignRateMatch]"
            )

    rejection = metrics.get("rejectionBehavior")
    if rejection is not None:
        outcome_total = (
            rejection["acceptedSignCount"]
            + rejection["lowConfidenceRejectionCount"]
            + rejection["noSignDecisionCount"]
        )
        if outcome_total != metrics["sampleCount"]:
            errors.append(
                "/evaluation/metrics/rejectionBehavior [keyword=outcomeCountTotal]"
            )
        if not _same_rate(
            rejection["minimumConfidence"], metadata.get("decision", {}).get("minimumConfidence")
        ):
            errors.append(
                "/evaluation/metrics/rejectionBehavior/minimumConfidence "
                "[keyword=runtimeThresholdMatch]"
            )
        expected_rejection_rate = (
            0.0
            if metrics["sampleCount"] == 0
            else rejection["lowConfidenceRejectionCount"] / metrics["sampleCount"]
        )
        if not _same_rate(rejection["rejectionRate"], expected_rejection_rate):
            errors.append(
                "/evaluation/metrics/rejectionBehavior/rejectionRate "
                "[keyword=countDerivedRate]"
            )
        if (
            rejection["unknownRejectedCount"] + rejection["unknownFalseFinalCount"]
            != rejection["unknownSampleCount"]
        ):
            errors.append(
                "/evaluation/metrics/rejectionBehavior [keyword=unknownOutcomeCountTotal]"
            )
        unknown_count = rejection["unknownSampleCount"]
        if unknown_count > metrics["sampleCount"]:
            errors.append(
                "/evaluation/metrics/rejectionBehavior/unknownSampleCount "
                "[keyword=boundedByEvaluationSampleCount]"
            )
        expected_unknown_rejection = (
            None if unknown_count == 0 else rejection["unknownRejectedCount"] / unknown_count
        )
        expected_unknown_false_final = (
            None if unknown_count == 0 else rejection["unknownFalseFinalCount"] / unknown_count
        )
        if not _same_nullable_rate(
            rejection["unknownRejectionRate"], expected_unknown_rejection
        ):
            errors.append(
                "/evaluation/metrics/rejectionBehavior/unknownRejectionRate "
                "[keyword=countDerivedRate]"
            )
        if not _same_nullable_rate(
            rejection["unknownFalseFinalRate"], expected_unknown_false_final
        ):
            errors.append(
                "/evaluation/metrics/rejectionBehavior/unknownFalseFinalRate "
                "[keyword=countDerivedRate]"
            )
        if (rejection["acceptedSignCount"] == 0) != (
            rejection["acceptedSignAccuracy"] is None
        ):
            errors.append(
                "/evaluation/metrics/rejectionBehavior/acceptedSignAccuracy "
                "[keyword=acceptedSampleAvailability]"
            )


def _matrix_derived_metric_errors(
    metrics: dict[str, Any],
    labels: list[dict[str, Any]],
    rows: list[list[int]],
    errors: list[str],
) -> None:
    sample_count = sum(sum(row) for row in rows)
    if sample_count != metrics["sampleCount"]:
        errors.append(
            "/evaluation/metrics/sampleCount [keyword=confusionMatrixTotal]"
        )

    diagonal = sum(rows[index][index] for index in range(len(rows)))
    expected_accuracy = 0.0 if sample_count == 0 else diagonal / sample_count
    if not _same_rate(metrics["accuracy"], expected_accuracy):
        errors.append("/evaluation/metrics/accuracy [keyword=confusionMatrixDerived]")

    derived_f1: list[float] = []
    reject_support = 0
    for index, label in enumerate(labels):
        true_positive = rows[index][index]
        support = sum(rows[index])
        predicted = sum(row[index] for row in rows)
        expected_precision = 0.0 if predicted == 0 else true_positive / predicted
        expected_recall = 0.0 if support == 0 else true_positive / support
        f1_denominator = 2 * true_positive + (predicted - true_positive) + (
            support - true_positive
        )
        expected_f1 = 0.0 if f1_denominator == 0 else 2 * true_positive / f1_denominator
        derived_f1.append(expected_f1)
        if label["outcome"] == "REJECT":
            reject_support += support

        if metrics.get("perClass") is not None and index < len(metrics["perClass"]):
            reported = metrics["perClass"][index]
            if reported["support"] != support:
                errors.append(
                    f"/evaluation/metrics/perClass/{index}/support "
                    "[keyword=confusionMatrixDerived]"
                )
            for key, expected in (
                ("precision", expected_precision),
                ("recall", expected_recall),
                ("f1", expected_f1),
            ):
                if not _same_rate(reported[key], expected):
                    errors.append(
                        f"/evaluation/metrics/perClass/{index}/{key} "
                        "[keyword=confusionMatrixDerived]"
                    )

        if label["outcome"] == "NO_SIGN" and metrics.get("noSignBehavior") is not None:
            if metrics["noSignBehavior"]["sampleCount"] != support:
                errors.append(
                    "/evaluation/metrics/noSignBehavior/sampleCount "
                    "[keyword=noSignMatrixSupport]"
                )

    expected_macro_f1 = 0.0 if not derived_f1 else sum(derived_f1) / len(derived_f1)
    if not _same_rate(metrics["macroF1"], expected_macro_f1):
        errors.append("/evaluation/metrics/macroF1 [keyword=confusionMatrixDerived]")
    if (
        metrics.get("rejectionBehavior") is not None
        and metrics["rejectionBehavior"]["unknownSampleCount"] != reject_support
    ):
        errors.append(
            "/evaluation/metrics/rejectionBehavior/unknownSampleCount "
            "[keyword=rejectLabelMatrixSupport]"
        )


def _same_rate(actual: Any, expected: Any) -> bool:
    return (
        isinstance(actual, (int, float))
        and not isinstance(actual, bool)
        and isinstance(expected, (int, float))
        and not isinstance(expected, bool)
        and abs(float(actual) - float(expected)) <= 1e-12
    )


def _same_nullable_rate(actual: Any, expected: Any) -> bool:
    return actual is None and expected is None or _same_rate(actual, expected)


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
