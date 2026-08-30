from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from signconnect_ml.release_bundle import ReleaseBundleError, build_release_bundle


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MODEL_SHA256 = "e75e38a9d16894c8b84a97689548837d7b191b079daa036adb483a84ce780748"


def _write_json(path: Path, value: dict) -> Path:
    path.write_text(
        json.dumps(value, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return path


def _runtime_report(metadata: dict) -> dict:
    report = {
        "schemaVersion": 1,
        "benchmarkId": "release-java-cpu",
        "recordedAt": "2026-08-30T14:00:00Z",
        "evidenceSource": "MEASURED_JAVA_ONNX_RUNTIME",
        "artifactSha256": metadata["artifactSha256"],
        "vocabularySha256": metadata["vocabularySha256"],
        "modelId": metadata["modelId"],
        "modelVersion": metadata["modelVersion"],
        "environment": {
            "javaVersion": "21.0.8",
            "onnxRuntimeVersion": "1.22.0",
            "osName": "Windows 11",
            "osArch": "amd64",
            "executionProvider": "CPUExecutionProvider",
            "availableProcessors": 8,
        },
        "protocol": {
            "warmupIterations": 10,
            "measurementIterations": 20,
            "batchSize": 1,
            "concurrency": 1,
            "measuredDurationNanos": 2_000_000_000,
            "measuredInferenceCount": 20,
        },
        "measurements": {
            "latencyNanos": [118_400_000] * 20,
            "processCpuLoadPercent": [25.0] * 20,
            "usedHeapBytes": [1024 * index for index in range(1, 21)],
        },
        "summary": {
            "p50LatencyMs": 118.4,
            "p95LatencyMs": 118.4,
            "meanProcessCpuLoadPercent": 25.0,
            "peakUsedHeapBytes": 20_480,
            "sustainedFps": 10.0,
        },
    }
    report["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(report, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return report


def _release_artifacts(tmp_path: Path, version: str = "1.2.3") -> dict[str, Path]:
    metadata = json.loads(
        (
            REPOSITORY_ROOT
            / "contracts/sign-recognition-training/v1/fixtures/model-metadata-production.valid.json"
        ).read_text(encoding="utf-8")
    )
    model_path = tmp_path / "model.onnx"
    model_path.write_bytes(b"candidate-model-v1")
    review_path = _write_json(
        tmp_path / "review.json",
        {
            "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
            "status": "APPROVED",
            "vocabularyVersion": "1.0.0",
        },
    )
    metadata["modelVersion"] = version
    metadata["artifactSha256"] = MODEL_SHA256
    metadata["sgslReview"]["reviewArtifactSha256"] = hashlib.sha256(
        review_path.read_bytes()
    ).hexdigest()

    return {
        "model": model_path,
        "metadata": _write_json(tmp_path / "metadata.json", metadata),
        "vocabulary": _write_json(
            tmp_path / "vocabulary.json",
            {
                "targetLanguage": metadata["targetLanguage"],
                "vocabularyVersion": metadata["vocabularyVersion"],
                "labels": metadata["labels"],
            },
        ),
        "evaluation": _write_json(
            tmp_path / "evaluation.json", metadata["evaluation"]
        ),
        "review": review_path,
        "runtime": _write_json(tmp_path / "runtime.json", _runtime_report(metadata)),
    }


def _build(
    tmp_path: Path,
    *,
    release_version: str = "1.2.3",
    first_release: bool = True,
    previous_known_good_version: str | None = None,
    existing_bundle: dict | None = None,
) -> dict:
    artifacts = _release_artifacts(tmp_path, release_version)
    return _build_from_artifacts(
        artifacts,
        release_version=release_version,
        first_release=first_release,
        previous_known_good_version=previous_known_good_version,
        existing_bundle=existing_bundle,
    )


def _build_from_artifacts(
    artifacts: dict[str, Path],
    *,
    release_version: str = "1.2.3",
    first_release: bool = True,
    previous_known_good_version: str | None = None,
    existing_bundle: dict | None = None,
) -> dict:
    return build_release_bundle(
        release_version=release_version,
        first_release=first_release,
        previous_known_good_version=previous_known_good_version,
        model_path=artifacts["model"],
        metadata_path=artifacts["metadata"],
        vocabulary_path=artifacts["vocabulary"],
        evaluation_path=artifacts["evaluation"],
        review_path=artifacts["review"],
        runtime_path=artifacts["runtime"],
        existing_bundle=existing_bundle,
    )


def test_release_bundle_pins_every_required_artifact(tmp_path: Path):
    bundle = _build(tmp_path)

    assert bundle["schemaVersion"] == 1
    assert bundle["releaseVersion"] == "1.2.3"
    assert bundle["previousKnownGoodVersion"] is None
    assert set(bundle["artifacts"]) == {
        "model",
        "metadata",
        "vocabulary",
        "evaluation",
        "review",
        "runtime",
    }
    assert bundle["artifacts"]["model"] == {
        "sha256": MODEL_SHA256,
        "sizeBytes": 18,
    }
    assert all(
        len(artifact["sha256"]) == 64 and artifact["sizeBytes"] > 0
        for artifact in bundle["artifacts"].values()
    )


@pytest.mark.parametrize(
    "invalid_version",
    ["v1.2.3", "1.2", "01.2.3", "1.2.3-candidate", "1.2.3+rebuilt"],
)
def test_release_requires_an_unambiguous_stable_semantic_version(
    tmp_path: Path, invalid_version: str
):
    with pytest.raises(ReleaseBundleError, match="stable semantic version"):
        _build(tmp_path, release_version=invalid_version)


@pytest.mark.parametrize(
    ("first_release", "previous_version", "message"),
    [
        (False, None, "required after the first release"),
        (True, "1.2.2", "must be null for the first release"),
        (False, "1.2", "stable semantic version"),
        (False, "1.2.3", "earlier than release_version"),
        (False, "2.0.0", "earlier than release_version"),
    ],
)
def test_previous_known_good_is_null_only_for_the_first_release(
    tmp_path: Path,
    first_release: bool,
    previous_version: str | None,
    message: str,
):
    with pytest.raises(ReleaseBundleError, match=message):
        _build(
            tmp_path,
            first_release=first_release,
            previous_known_good_version=previous_version,
        )


def test_subsequent_release_pins_an_earlier_known_good_version(tmp_path: Path):
    bundle = _build(
        tmp_path,
        first_release=False,
        previous_known_good_version="1.2.2",
    )

    assert bundle["previousKnownGoodVersion"] == "1.2.2"


def test_empty_required_artifact_fails_closed(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    artifacts["runtime"].write_bytes(b"")

    with pytest.raises(
        ReleaseBundleError,
        match="runtime artifact must be a non-empty regular file",
    ):
        _build_from_artifacts(artifacts)


@pytest.mark.parametrize(
    "artifact_name",
    ["metadata", "vocabulary", "evaluation", "review", "runtime"],
)
@pytest.mark.parametrize("invalid_json", ["[]", "{}"])
def test_every_report_must_be_a_json_object(
    tmp_path: Path, artifact_name: str, invalid_json: str
):
    artifacts = _release_artifacts(tmp_path)
    artifacts[artifact_name].write_text(invalid_json, encoding="utf-8")

    with pytest.raises(
        ReleaseBundleError,
        match=f"{artifact_name} artifact must contain one JSON object",
    ):
        _build_from_artifacts(artifacts)


def test_non_promoted_metadata_fails_closed(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    metadata = json.loads(artifacts["metadata"].read_text(encoding="utf-8"))
    metadata["productionPromotion"] = {
        "status": "BLOCKED",
        "assessedAt": "2026-08-30T13:00:00Z",
        "blockingReasons": ["External approval is incomplete."],
    }
    _write_json(artifacts["metadata"], metadata)

    with pytest.raises(ReleaseBundleError, match="production-approved metadata"):
        _build_from_artifacts(artifacts)


def test_metadata_must_bind_the_exact_model_bytes(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    artifacts["model"].write_bytes(b"different-model-bytes")

    with pytest.raises(ReleaseBundleError, match="model SHA-256"):
        _build_from_artifacts(artifacts)


def test_metadata_must_bind_the_exact_review_record(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    artifacts["review"].write_text('{"status":"REPLACED"}', encoding="utf-8")

    with pytest.raises(ReleaseBundleError, match="review SHA-256"):
        _build_from_artifacts(artifacts)


def test_metadata_must_bind_the_canonical_vocabulary(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    vocabulary = json.loads(artifacts["vocabulary"].read_text(encoding="utf-8"))
    vocabulary["labels"][1]["captionText"] = "Changed after review"
    _write_json(artifacts["vocabulary"], vocabulary)

    with pytest.raises(ReleaseBundleError, match="canonical vocabulary"):
        _build_from_artifacts(artifacts)


def test_evaluation_report_must_exactly_match_promoted_metadata(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    evaluation = json.loads(artifacts["evaluation"].read_text(encoding="utf-8"))
    evaluation["unreviewedMetric"] = 1.0
    _write_json(artifacts["evaluation"], evaluation)

    with pytest.raises(ReleaseBundleError, match="evaluation report"):
        _build_from_artifacts(artifacts)


def test_runtime_report_must_bind_the_exact_model_artifact(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["artifactSha256"] = "0" * 64
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report.*model artifact"):
        _build_from_artifacts(artifacts)


@pytest.mark.parametrize(
    ("field", "replacement", "message"),
    [
        ("modelId", "different-model", "model identity"),
        ("modelVersion", "1.2.2", "model identity"),
        ("vocabularySha256", "1" * 64, "vocabulary"),
    ],
)
def test_runtime_report_must_bind_model_and_vocabulary_identity(
    tmp_path: Path, field: str, replacement: str, message: str
):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime[field] = replacement
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match=f"runtime report.*{message}"):
        _build_from_artifacts(artifacts)


def test_runtime_report_rejects_unknown_schema_fields(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["estimated"] = True
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report schema"):
        _build_from_artifacts(artifacts)


def test_runtime_report_requires_raw_latency_cpu_and_memory_measurements(
    tmp_path: Path,
):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    del runtime["measurements"]["processCpuLoadPercent"]
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report measurements"):
        _build_from_artifacts(artifacts)


def test_runtime_report_requires_complete_raw_measurement_series(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["measurements"]["usedHeapBytes"].pop()
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report measurements"):
        _build_from_artifacts(artifacts)


def test_runtime_report_recomputes_summary_from_raw_measurements(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["summary"]["p95LatencyMs"] = 1.0
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report summary"):
        _build_from_artifacts(artifacts)


def test_runtime_report_recomputes_embedded_evidence_digest(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["measurements"]["usedHeapBytes"][0] += 1
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report evidence digest"):
        _build_from_artifacts(artifacts)


def test_runtime_report_requires_measured_java_onnx_evidence(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["evidenceSource"] = "ESTIMATED"
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report provenance"):
        _build_from_artifacts(artifacts)


def test_runtime_report_requires_the_promoted_java_cpu_environment(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    runtime["environment"]["executionProvider"] = "CUDAExecutionProvider"
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match="runtime report environment"):
        _build_from_artifacts(artifacts)


def test_runtime_report_must_bind_the_promoted_latency_measurement(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    metadata = json.loads(artifacts["metadata"].read_text(encoding="utf-8"))
    metadata["runtime"]["warmedP95LatencyMs"] = 100.0
    _write_json(artifacts["metadata"], metadata)

    with pytest.raises(ReleaseBundleError, match="runtime report.*promoted p95"):
        _build_from_artifacts(artifacts)


@pytest.mark.parametrize(
    ("container", "field", "message"),
    [
        (None, "schemaVersion", "provenance"),
        ("protocol", "batchSize", "protocol"),
        ("protocol", "concurrency", "protocol"),
    ],
)
def test_runtime_report_integer_contracts_reject_booleans(
    tmp_path: Path, container: str | None, field: str, message: str
):
    artifacts = _release_artifacts(tmp_path)
    runtime = json.loads(artifacts["runtime"].read_text(encoding="utf-8"))
    target = runtime if container is None else runtime[container]
    target[field] = True
    unsigned = dict(runtime)
    del unsigned["evidenceDigestSha256"]
    runtime["evidenceDigestSha256"] = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_json(artifacts["runtime"], runtime)

    with pytest.raises(ReleaseBundleError, match=f"runtime report {message}"):
        _build_from_artifacts(artifacts)


def test_release_version_must_match_promoted_model_version(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    metadata = json.loads(artifacts["metadata"].read_text(encoding="utf-8"))
    metadata["modelVersion"] = "1.2.4"
    _write_json(artifacts["metadata"], metadata)

    with pytest.raises(ReleaseBundleError, match="modelVersion"):
        _build_from_artifacts(artifacts)


def test_invalid_promoted_metadata_contract_fails_closed(tmp_path: Path):
    artifacts = _release_artifacts(tmp_path)
    metadata = json.loads(artifacts["metadata"].read_text(encoding="utf-8"))
    del metadata["input"]
    _write_json(artifacts["metadata"], metadata)

    with pytest.raises(ReleaseBundleError, match="metadata contract"):
        _build_from_artifacts(artifacts)


def test_release_version_cannot_be_reused_for_different_artifact_bytes(
    tmp_path: Path,
):
    first_dir = tmp_path / "first"
    replacement_dir = tmp_path / "replacement"
    first_dir.mkdir()
    replacement_dir.mkdir()
    existing_bundle = _build(first_dir)
    replacement = _release_artifacts(replacement_dir)
    replacement["model"].write_bytes(b"retrained-model-with-different-weights")
    metadata = json.loads(replacement["metadata"].read_text(encoding="utf-8"))
    metadata["artifactSha256"] = hashlib.sha256(
        replacement["model"].read_bytes()
    ).hexdigest()
    _write_json(replacement["metadata"], metadata)
    _write_json(replacement["runtime"], _runtime_report(metadata))

    with pytest.raises(
        ReleaseBundleError,
        match="release version 1.2.3 is already pinned to different artifact bytes",
    ):
        _build_from_artifacts(replacement, existing_bundle=existing_bundle)


def test_model_card_is_deterministic_and_summarizes_release_evidence(
    tmp_path: Path,
):
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()

    first = _build(first_dir)
    second = _build(second_dir)

    assert first["modelCardMarkdown"] == second["modelCardMarkdown"]
    assert first["modelCardSha256"] == second["modelCardSha256"]
    assert first["modelCardMarkdown"].startswith("# SignConnect Model Card\n")
    assert "- Model: `contract-fixture-sgsl-tcn`" in first["modelCardMarkdown"]
    assert "- Version: `1.2.3`" in first["modelCardMarkdown"]
    assert (
        "- Supported sign labels: `HELLO`, `THANK_YOU`, `YES`, `NO`, `HELP`"
        in first["modelCardMarkdown"]
    )
    assert "- Signer-independent macro-F1: `0.868893`" in first["modelCardMarkdown"]
    assert "- False-final rate: `0.033333`" in first["modelCardMarkdown"]
    assert "- Warmed Java CPU p95 latency: `118.400 ms`" in first["modelCardMarkdown"]
    assert f"- model: `{MODEL_SHA256}`" in first["modelCardMarkdown"]


def test_manual_runbook_covers_restart_and_known_good_rollback(tmp_path: Path):
    bundle = _build(
        tmp_path,
        first_release=False,
        previous_known_good_version="1.2.2",
    )

    runbook = bundle["manualRunbookMarkdown"]
    assert runbook.startswith("# SignConnect Manual Release and Rollback Runbook\n")
    assert "Release `1.2.3`" in runbook
    assert "verify all six SHA-256 pins" in runbook
    assert "stop the realtime service" in runbook
    assert "restart the inference service" in runbook
    assert "confirm readiness before restarting the realtime service" in runbook
    assert "restore previous-known-good release `1.2.2`" in runbook
    assert "registry" not in runbook.lower()
    assert "canary" not in runbook.lower()
    assert bundle["manualRunbookSha256"] == hashlib.sha256(
        runbook.encode("utf-8")
    ).hexdigest()


@pytest.mark.parametrize(
    "malformed_existing",
    [
        {"schemaVersion": 1, "releaseVersion": "not-semver", "artifacts": {}},
        [],
    ],
)
def test_malformed_existing_bundle_cannot_bypass_version_reuse_check(
    tmp_path: Path, malformed_existing: object
):
    with pytest.raises(ReleaseBundleError, match="existing release bundle is invalid"):
        _build(tmp_path, existing_bundle=malformed_existing)  # type: ignore[arg-type]
