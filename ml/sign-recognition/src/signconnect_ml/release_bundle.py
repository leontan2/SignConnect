from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from .contracts import (
    ContractError,
    canonical_vocabulary_sha256,
    validate_contract_document,
)


class ReleaseBundleError(ValueError):
    """A release bundle cannot be created without every promotion safeguard."""


_STABLE_SEMANTIC_VERSION = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$"
)
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_BENCHMARK_ID = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
_ARTIFACT_NAMES = (
    "model",
    "metadata",
    "vocabulary",
    "evaluation",
    "review",
    "runtime",
)
_RUNTIME_REPORT_FIELDS = frozenset(
    {
        "schemaVersion",
        "benchmarkId",
        "recordedAt",
        "evidenceSource",
        "artifactSha256",
        "vocabularySha256",
        "modelId",
        "modelVersion",
        "environment",
        "protocol",
        "measurements",
        "summary",
        "evidenceDigestSha256",
    }
)
_RUNTIME_MEASUREMENT_FIELDS = frozenset(
    {"latencyNanos", "processCpuLoadPercent", "usedHeapBytes"}
)
_RUNTIME_PROTOCOL_FIELDS = frozenset(
    {
        "warmupIterations",
        "measurementIterations",
        "batchSize",
        "concurrency",
        "measuredDurationNanos",
        "measuredInferenceCount",
    }
)
_RUNTIME_SUMMARY_FIELDS = frozenset(
    {
        "p50LatencyMs",
        "p95LatencyMs",
        "meanProcessCpuLoadPercent",
        "peakUsedHeapBytes",
        "sustainedFps",
    }
)
_RUNTIME_ENVIRONMENT_FIELDS = frozenset(
    {
        "javaVersion",
        "onnxRuntimeVersion",
        "osName",
        "osArch",
        "executionProvider",
        "availableProcessors",
    }
)


def build_release_bundle(
    *,
    release_version: str,
    first_release: bool,
    previous_known_good_version: str | None,
    model_path: str | Path,
    metadata_path: str | Path,
    vocabulary_path: str | Path,
    evaluation_path: str | Path,
    review_path: str | Path,
    runtime_path: str | Path,
    existing_bundle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a deterministic manifest that pins every release artifact."""

    if _STABLE_SEMANTIC_VERSION.fullmatch(release_version) is None:
        raise ReleaseBundleError(
            "release_version must be an unambiguous stable semantic version"
        )
    if first_release:
        if previous_known_good_version is not None:
            raise ReleaseBundleError(
                "previous_known_good_version must be null for the first release"
            )
    else:
        if previous_known_good_version is None:
            raise ReleaseBundleError(
                "previous_known_good_version is required after the first release"
            )
        if _STABLE_SEMANTIC_VERSION.fullmatch(previous_known_good_version) is None:
            raise ReleaseBundleError(
                "previous_known_good_version must be a stable semantic version"
            )
        if _version_tuple(previous_known_good_version) >= _version_tuple(
            release_version
        ):
            raise ReleaseBundleError(
                "previous_known_good_version must be earlier than release_version"
            )
    if existing_bundle is not None:
        _validate_existing_bundle(existing_bundle)

    paths = {
        "model": Path(model_path),
        "metadata": Path(metadata_path),
        "vocabulary": Path(vocabulary_path),
        "evaluation": Path(evaluation_path),
        "review": Path(review_path),
        "runtime": Path(runtime_path),
    }
    contents = {
        name: _read_artifact(name, path) for name, path in paths.items()
    }
    artifacts = {
        name: _artifact_pin(artifact_contents)
        for name, artifact_contents in contents.items()
    }
    documents = {
        name: _load_json_object(name, contents[name])
        for name in _ARTIFACT_NAMES[1:]
    }
    try:
        validate_contract_document(
            documents["metadata"], "model-metadata.schema.json"
        )
    except ContractError as error:
        raise ReleaseBundleError(
            "metadata contract validation failed"
        ) from error
    if documents["metadata"].get("productionPromotion", {}).get("status") != "APPROVED":
        raise ReleaseBundleError(
            "release bundle requires production-approved metadata"
        )
    if documents["metadata"].get("artifactSha256") != artifacts["model"]["sha256"]:
        raise ReleaseBundleError(
            "metadata model SHA-256 does not match the bundled model bytes"
        )
    if documents["metadata"].get("modelVersion") != release_version:
        raise ReleaseBundleError(
            "metadata modelVersion does not match release_version"
        )
    vocabulary = documents["vocabulary"]
    metadata = documents["metadata"]
    if documents["evaluation"] != metadata["evaluation"]:
        raise ReleaseBundleError(
            "bundled evaluation report does not match promoted metadata"
        )
    if set(documents["runtime"]) != _RUNTIME_REPORT_FIELDS:
        raise ReleaseBundleError("bundled runtime report schema is invalid")
    if (
        type(documents["runtime"].get("schemaVersion")) is not int
        or documents["runtime"]["schemaVersion"] != 1
        or documents["runtime"].get("evidenceSource")
        != "MEASURED_JAVA_ONNX_RUNTIME"
        or not isinstance(documents["runtime"].get("benchmarkId"), str)
        or _BENCHMARK_ID.fullmatch(documents["runtime"]["benchmarkId"]) is None
        or not _valid_timestamp(documents["runtime"].get("recordedAt"))
    ):
        raise ReleaseBundleError("bundled runtime report provenance is invalid")
    environment = documents["runtime"].get("environment")
    if (
        not isinstance(environment, Mapping)
        or set(environment) != _RUNTIME_ENVIRONMENT_FIELDS
        or any(
            not _bounded_text(environment.get(field))
            for field in ("javaVersion", "onnxRuntimeVersion", "osName", "osArch")
        )
        or environment.get("executionProvider") != "CPUExecutionProvider"
        or environment["executionProvider"]
        not in metadata["runtime"]["executionProviders"]
        or type(environment.get("availableProcessors")) is not int
        or not 1 <= environment["availableProcessors"] <= 1_000_000
        or not _runtime_version_at_least(
            environment["onnxRuntimeVersion"],
            metadata["runtime"]["minimumVersion"],
        )
    ):
        raise ReleaseBundleError("bundled runtime report environment is invalid")
    measurements = documents["runtime"].get("measurements")
    if not isinstance(measurements, Mapping) or set(measurements) != (
        _RUNTIME_MEASUREMENT_FIELDS
    ):
        raise ReleaseBundleError("bundled runtime report measurements are invalid")
    protocol = documents["runtime"].get("protocol")
    if not isinstance(protocol, Mapping) or set(protocol) != _RUNTIME_PROTOCOL_FIELDS:
        raise ReleaseBundleError("bundled runtime report protocol is invalid")
    measurement_count = protocol.get("measurementIterations")
    if (
        type(protocol.get("warmupIterations")) is not int
        or protocol["warmupIterations"] < 1
        or type(measurement_count) is not int
        or not 20 <= measurement_count <= 100_000
        or type(protocol.get("batchSize")) is not int
        or protocol["batchSize"] != 1
        or type(protocol.get("concurrency")) is not int
        or protocol["concurrency"] != 1
        or type(protocol.get("measuredDurationNanos")) is not int
        or protocol["measuredDurationNanos"] <= 0
        or type(protocol.get("measuredInferenceCount")) is not int
        or protocol["measuredInferenceCount"] != measurement_count
    ):
        raise ReleaseBundleError("bundled runtime report protocol is invalid")
    latency_samples = measurements["latencyNanos"]
    cpu_samples = measurements["processCpuLoadPercent"]
    heap_samples = measurements["usedHeapBytes"]
    if (
        not all(
            isinstance(values, list) and len(values) == measurement_count
            for values in (latency_samples, cpu_samples, heap_samples)
        )
        or any(type(value) is not int or value < 0 for value in latency_samples)
        or any(
            not _finite_number(value) or not 0 <= float(value) <= 100
            for value in cpu_samples
        )
        or any(type(value) is not int or value < 0 for value in heap_samples)
    ):
        raise ReleaseBundleError("bundled runtime report measurements are invalid")
    summary = documents["runtime"].get("summary")
    if not isinstance(summary, Mapping) or set(summary) != _RUNTIME_SUMMARY_FIELDS:
        raise ReleaseBundleError("bundled runtime report summary is invalid")
    ordered_latency = sorted(latency_samples)
    expected_summary = {
        "p50LatencyMs": ordered_latency[math.ceil(0.50 * measurement_count) - 1]
        / 1_000_000,
        "p95LatencyMs": ordered_latency[math.ceil(0.95 * measurement_count) - 1]
        / 1_000_000,
        "meanProcessCpuLoadPercent": sum(cpu_samples) / measurement_count,
        "peakUsedHeapBytes": max(heap_samples),
        "sustainedFps": protocol["measuredInferenceCount"]
        / (protocol["measuredDurationNanos"] / 1_000_000_000),
    }
    summary_numbers_valid = all(
        _finite_number(summary.get(field))
        for field in _RUNTIME_SUMMARY_FIELDS - {"peakUsedHeapBytes"}
    ) and type(summary.get("peakUsedHeapBytes")) is int
    if not summary_numbers_valid or any(
        not math.isclose(
            float(summary[field]),
            float(expected),
            rel_tol=1e-9,
            abs_tol=1e-9,
        )
        for field, expected in expected_summary.items()
    ):
        raise ReleaseBundleError("bundled runtime report summary is invalid")
    if not math.isclose(
        float(summary["p95LatencyMs"]),
        float(metadata["runtime"]["warmedP95LatencyMs"]),
        rel_tol=1e-9,
        abs_tol=1e-9,
    ):
        raise ReleaseBundleError(
            "bundled runtime report does not match the promoted p95 measurement"
        )
    evidence_digest = documents["runtime"].get("evidenceDigestSha256")
    unsigned_runtime = dict(documents["runtime"])
    del unsigned_runtime["evidenceDigestSha256"]
    recomputed_evidence_digest = hashlib.sha256(
        json.dumps(
            unsigned_runtime,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    if (
        not isinstance(evidence_digest, str)
        or _SHA256.fullmatch(evidence_digest) is None
        or evidence_digest != recomputed_evidence_digest
    ):
        raise ReleaseBundleError("bundled runtime report evidence digest is invalid")
    if documents["runtime"].get("artifactSha256") != metadata["artifactSha256"]:
        raise ReleaseBundleError(
            "bundled runtime report does not match the selected model artifact"
        )
    if (
        documents["runtime"].get("modelId") != metadata["modelId"]
        or documents["runtime"].get("modelVersion") != metadata["modelVersion"]
    ):
        raise ReleaseBundleError(
            "bundled runtime report does not match the selected model identity"
        )
    if (
        documents["runtime"].get("vocabularySha256")
        != metadata["vocabularySha256"]
    ):
        raise ReleaseBundleError(
            "bundled runtime report does not match the selected vocabulary"
        )
    expected_vocabulary = {
        "targetLanguage": metadata["targetLanguage"],
        "vocabularyVersion": metadata["vocabularyVersion"],
        "labels": metadata["labels"],
    }
    vocabulary_sha256 = canonical_vocabulary_sha256(
        vocabulary.get("targetLanguage"),
        vocabulary.get("vocabularyVersion"),
        vocabulary.get("labels", []),
    )
    if (
        vocabulary != expected_vocabulary
        or vocabulary_sha256 != metadata["vocabularySha256"]
    ):
        raise ReleaseBundleError(
            "bundled canonical vocabulary does not match promoted metadata"
        )
    review_sha256 = documents["metadata"].get("sgslReview", {}).get(
        "reviewArtifactSha256"
    )
    if review_sha256 != artifacts["review"]["sha256"]:
        raise ReleaseBundleError(
            "metadata review SHA-256 does not match the bundled review record"
        )
    if (
        existing_bundle is not None
        and existing_bundle.get("releaseVersion") == release_version
        and existing_bundle.get("artifacts") != artifacts
    ):
        raise ReleaseBundleError(
            f"release version {release_version} is already pinned to different artifact bytes"
        )
    model_card = _render_model_card(documents["metadata"], artifacts)
    manual_runbook = _render_manual_runbook(
        release_version, previous_known_good_version
    )
    return {
        "schemaVersion": 1,
        "releaseVersion": release_version,
        "previousKnownGoodVersion": previous_known_good_version,
        "artifacts": artifacts,
        "modelCardMarkdown": model_card,
        "modelCardSha256": hashlib.sha256(model_card.encode("utf-8")).hexdigest(),
        "manualRunbookMarkdown": manual_runbook,
        "manualRunbookSha256": hashlib.sha256(
            manual_runbook.encode("utf-8")
        ).hexdigest(),
    }


def _read_artifact(name: str, path: Path) -> bytes:
    try:
        if not path.is_file():
            raise OSError
        contents = path.read_bytes()
    except OSError as error:
        raise ReleaseBundleError(
            f"{name} artifact must be a non-empty regular file"
        ) from error
    if not contents:
        raise ReleaseBundleError(
            f"{name} artifact must be a non-empty regular file"
        )
    return contents


def _artifact_pin(contents: bytes) -> dict[str, Any]:
    return {
        "sha256": hashlib.sha256(contents).hexdigest(),
        "sizeBytes": len(contents),
    }


def _finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError:
        return False
    return True


def _bounded_text(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= 128
        and not value.isspace()
        and not any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)
    )


def _runtime_version_at_least(actual: str, minimum: str) -> bool:
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", actual) is None:
        return False
    return _version_tuple(actual) >= _version_tuple(minimum)


def _version_tuple(version: str) -> tuple[int, int, int]:
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


def _load_json_object(name: str, contents: bytes) -> dict[str, Any]:
    try:
        document = json.loads(contents.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ReleaseBundleError(
            f"{name} artifact must contain one JSON object"
        ) from error
    if not isinstance(document, dict) or not document:
        raise ReleaseBundleError(f"{name} artifact must contain one JSON object")
    return document


def _validate_existing_bundle(bundle: Mapping[str, Any]) -> None:
    if not isinstance(bundle, Mapping):
        raise ReleaseBundleError("existing release bundle is invalid")
    artifacts = bundle.get("artifacts")
    version = bundle.get("releaseVersion")
    valid = (
        bundle.get("schemaVersion") == 1
        and isinstance(version, str)
        and _STABLE_SEMANTIC_VERSION.fullmatch(version) is not None
        and isinstance(artifacts, Mapping)
        and set(artifacts) == set(_ARTIFACT_NAMES)
    )
    if valid:
        for name in _ARTIFACT_NAMES:
            pin = artifacts[name]
            if (
                not isinstance(pin, Mapping)
                or set(pin) != {"sha256", "sizeBytes"}
                or not isinstance(pin["sha256"], str)
                or _SHA256.fullmatch(pin["sha256"]) is None
                or type(pin["sizeBytes"]) is not int
                or pin["sizeBytes"] < 1
            ):
                valid = False
                break
    if not valid:
        raise ReleaseBundleError("existing release bundle is invalid")


def _render_model_card(
    metadata: Mapping[str, Any], artifacts: Mapping[str, Mapping[str, Any]]
) -> str:
    labels = metadata["labels"]
    sign_labels = [label["id"] for label in labels if label["outcome"] == "SIGN"]
    reserved_labels = [
        label["id"] for label in labels if label["outcome"] != "SIGN"
    ]
    evaluation = metadata["evaluation"]
    metrics = evaluation["metrics"]
    input_contract = metadata["input"]
    shape = " x ".join(str(dimension) for dimension in input_contract["shape"])
    lines = [
        "# SignConnect Model Card",
        "",
        "## Release",
        "",
        f"- Model: `{metadata['modelId']}`",
        f"- Version: `{metadata['modelVersion']}`",
        f"- Promotion status: `{metadata['productionPromotion']['status']}`",
        f"- Target language tag: `{metadata['targetLanguage']}`",
        f"- Architecture: `{metadata['architecture']['family']}`",
        "",
        "## Intended use and limits",
        "",
        "- Intended use: small-vocabulary isolated-sign recognition from transient landmark windows.",
        f"- Supported sign labels: {', '.join(f'`{label}`' for label in sign_labels)}",
        f"- Reserved outcomes: {', '.join(f'`{label}`' for label in reserved_labels)}",
        f"- Capture assumption: `{shape}` `{input_contract['tensorType']}` input using `{input_contract['featureLayoutVersion']}`.",
        "- Limitation: landmark-only input can omit non-manual sign features and must not be treated as open-ended translation.",
        "- Population scope: performance claims apply only to the signer-independent population represented by the pinned evaluation report.",
        f"- Rejection threshold: `{metadata['decision']['minimumConfidence']:.6f}`; lower-confidence and reserved outcomes do not become supported-sign captions.",
        "",
        "## Held-out and runtime evidence",
        "",
        f"- Held-out test signers: `{evaluation['protocol']['testSignerCount']}`",
        f"- Evaluation samples: `{metrics['sampleCount']}`",
        f"- Signer-independent macro-F1: `{metrics['macroF1']:.6f}`",
        f"- False-final rate: `{metrics['falseFinalRate']:.6f}`",
        f"- Unknown-sign rejection rate: `{metrics['rejectionBehavior']['unknownRejectionRate']:.6f}`",
        f"- Warmed Java CPU p95 latency: `{metadata['runtime']['warmedP95LatencyMs']:.3f} ms`",
        f"- SGSL review: `{metadata['sgslReview']['status']}` by `{metadata['sgslReview']['reviewerRole']}`",
        "",
        "## Artifact pins",
        "",
    ]
    lines.extend(
        f"- {name}: `{artifacts[name]['sha256']}`"
        for name in _ARTIFACT_NAMES
    )
    return "\n".join(lines) + "\n"


def _render_manual_runbook(
    release_version: str, previous_known_good_version: str | None
) -> str:
    rollback_target = (
        f"restore previous-known-good release `{previous_known_good_version}`"
        if previous_known_good_version is not None
        else "remove the first release and restore the documented pre-model deployment"
    )
    return "\n".join(
        [
            "# SignConnect Manual Release and Rollback Runbook",
            "",
            f"Release `{release_version}` must be handled as one immutable bundle.",
            "",
            "## Manual release and restart",
            "",
            "1. On the deployment host, verify all six SHA-256 pins against the bundle before replacing any file.",
            "2. Drain recognition requests, then stop the realtime service and the inference service.",
            "3. Install the model, metadata, vocabulary, evaluation, review, and runtime artifacts as one unit.",
            "4. Restart the inference service and confirm readiness before restarting the realtime service.",
            "5. Exercise one approved readiness probe and one recognition smoke test without recording camera or landmark data.",
            "",
            "## Manual rollback",
            "",
            "1. Drain recognition requests and stop the realtime service and the inference service.",
            f"2. If readiness, checksum, or smoke validation fails, {rollback_target} as one complete bundle.",
            "3. Verify every restored checksum, restart the inference service, confirm readiness, then restart the realtime service.",
            "4. Record the failed release version and reason without including camera frames, landmarks, tensors, or participant data.",
            "",
        ]
    )
