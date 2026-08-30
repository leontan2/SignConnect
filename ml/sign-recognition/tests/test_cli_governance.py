from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from signconnect_ml.cli import main


def _write_json(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
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


def test_lifecycle_inventory_reports_only_safe_identifiers_and_counts(
    tmp_path: Path, capsys
) -> None:
    data_root = tmp_path / "private-dataset"
    artifact = data_root / "source" / "private-record.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("private fixture", encoding="utf-8")
    index = _write_json(
        tmp_path / "private-index.json",
        [
            {
                "artifactId": "artifact-a",
                "kind": "SOURCE",
                "path": "source/private-record.json",
                "signerIds": ["signer-a"],
                "sampleIds": ["sample-a"],
                "retentionExpiresAt": "2026-09-30T00:00:00Z",
            }
        ],
    )

    exit_code = main(
        [
            "lifecycle-inventory",
            "--root",
            str(data_root),
            "--index",
            str(index),
            "--signer-id",
            "signer-a",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert json.loads(captured.out) == {
        "artifactIds": ["artifact-a"],
        "existingCount": 1,
        "missingCount": 0,
        "status": "PASS",
    }
    assert captured.err == ""
    assert str(data_root) not in captured.out
    assert "private-record.json" not in captured.out


def test_lifecycle_expiry_is_a_non_destructive_safe_report(
    tmp_path: Path, capsys
) -> None:
    data_root = tmp_path / "private-dataset"
    artifact = data_root / "source" / "private-record.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("must remain", encoding="utf-8")
    index = _write_json(
        tmp_path / "private-index.json",
        [
            {
                "artifactId": "artifact-a",
                "kind": "SOURCE",
                "path": "source/private-record.json",
                "signerIds": ["signer-a"],
                "sampleIds": ["sample-a"],
                "retentionExpiresAt": "2026-08-20T00:00:00Z",
            }
        ],
    )

    exit_code = main(
        [
            "lifecycle-expiry",
            "--root",
            str(data_root),
            "--index",
            str(index),
            "--as-of",
            "2026-08-30T00:00:00Z",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert json.loads(captured.out) == {
        "expiredArtifactIds": ["artifact-a"],
        "overdueArtifactIds": ["artifact-a"],
        "status": "PASS",
    }
    assert captured.err == ""
    assert artifact.read_text(encoding="utf-8") == "must remain"
    assert str(data_root) not in captured.out
    assert "private-record.json" not in captured.out


def test_lifecycle_deletion_cli_is_dry_run_only(tmp_path: Path, capsys) -> None:
    data_root = tmp_path / "private-dataset"
    artifact = data_root / "source" / "private-record.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("must remain", encoding="utf-8")
    index = _write_json(
        tmp_path / "private-index.json",
        [
            {
                "artifactId": "artifact-a",
                "kind": "SOURCE",
                "path": "source/private-record.json",
                "signerIds": ["signer-a"],
                "sampleIds": ["sample-a"],
                "retentionExpiresAt": "2026-09-30T00:00:00Z",
            }
        ],
    )

    exit_code = main(
        [
            "lifecycle-plan-deletion",
            "--root",
            str(data_root),
            "--index",
            str(index),
            "--signer-id",
            "signer-a",
            "--reason",
            "WITHDRAWAL",
            "--planned-at",
            "2026-08-30T00:00:00Z",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert json.loads(captured.out) == {
        "artifactIds": ["artifact-a"],
        "dryRun": True,
        "reason": "WITHDRAWAL",
        "status": "PASS",
    }
    assert artifact.read_text(encoding="utf-8") == "must remain"
    assert "confirm" not in captured.out.lower()
    assert str(data_root) not in captured.out
    assert "private-record.json" not in captured.out


def test_duplicate_audit_writes_safe_evidence_without_paths_or_vectors(
    tmp_path: Path, capsys
) -> None:
    data_root = tmp_path / "private-dataset"
    samples_dir = data_root / "samples"
    samples_dir.mkdir(parents=True)
    features = np.arange(24, dtype=np.float32).reshape(3, 8)
    records: list[dict[str, object]] = []
    for sample_id, signer_id, split in (
        ("sample-train", "signer-a", "train"),
        ("sample-test", "signer-b", "test"),
    ):
        relative_path = f"samples/{sample_id}-private.npz"
        artifact = data_root / relative_path
        np.savez_compressed(artifact, features=features)
        records.append(
            {
                "sampleId": sample_id,
                "signerId": signer_id,
                "splitAssignment": split,
                "landmarkArtifact": {
                    "path": relative_path,
                    "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                },
            }
        )
    samples = _write_json(tmp_path / "private-samples.json", records)
    output = tmp_path / "audit.json"

    exit_code = main(
        [
            "audit-duplicates",
            "--data-root",
            str(data_root),
            "--samples",
            str(samples),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert exit_code == 1
    assert json.loads(captured.out) == {
        "findingCount": 1,
        "sampleCount": 2,
        "status": "BLOCKED",
    }
    assert report["status"] == "BLOCKED"
    assert report["findings"][0]["kind"] == "EXACT_SHA256"
    assert report["findings"][0]["left"] == {
        "sampleId": "sample-test",
        "signerId": "signer-b",
        "split": "test",
    }
    encoded = output.read_text(encoding="utf-8") + captured.out
    assert str(data_root) not in encoded
    assert ".npz" not in encoded
    assert "features" not in encoded
    assert features.tobytes().hex() not in encoded


def test_promotion_cli_writes_blocked_metadata_and_a_safe_gate_summary(
    tmp_path: Path, capsys
) -> None:
    metadata = _write_json(tmp_path / "private-metadata.json", {})
    evidence = _write_json(tmp_path / "private-evidence.json", {})
    output = tmp_path / "promotion.json"

    exit_code = main(
        [
            "promote",
            "--metadata",
            str(metadata),
            "--model",
            str(tmp_path / "private-model.onnx"),
            "--evidence",
            str(evidence),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert json.loads(captured.out) == {
        "approved": False,
        "blockerCount": 1,
        "status": "BLOCKED",
    }
    assert json.loads(output.read_text(encoding="utf-8")) == {}
    assert captured.err == ""
    assert str(tmp_path) not in captured.out
    assert "private-model.onnx" not in captured.out


def test_release_bundle_cli_writes_bundle_and_prints_only_safe_summary(
    tmp_path: Path, capsys
) -> None:
    repository_root = Path(__file__).resolve().parents[3]
    metadata = json.loads(
        (
            repository_root
            / "contracts/sign-recognition-training/v1/fixtures/model-metadata-production.valid.json"
        ).read_text(encoding="utf-8")
    )
    model = tmp_path / "private-model.onnx"
    model.write_bytes(b"candidate-model-v1")
    review = _write_json(
        tmp_path / "private-review.json",
        {
            "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
            "status": "APPROVED",
            "vocabularyVersion": "1.0.0",
        },
    )
    metadata["modelVersion"] = "1.2.3"
    metadata["artifactSha256"] = hashlib.sha256(model.read_bytes()).hexdigest()
    metadata["sgslReview"]["reviewArtifactSha256"] = hashlib.sha256(
        review.read_bytes()
    ).hexdigest()
    artifacts = {
        "metadata": _write_json(tmp_path / "private-metadata.json", metadata),
        "vocabulary": _write_json(
            tmp_path / "private-vocabulary.json",
            {
                "targetLanguage": metadata["targetLanguage"],
                "vocabularyVersion": metadata["vocabularyVersion"],
                "labels": metadata["labels"],
            },
        ),
        "evaluation": _write_json(
            tmp_path / "private-evaluation.json", metadata["evaluation"]
        ),
        "runtime": _write_json(
            tmp_path / "private-runtime.json", _runtime_report(metadata)
        ),
    }
    output = tmp_path / "release-bundle.json"

    exit_code = main(
        [
            "build-release-bundle",
            "--release-version",
            "1.2.3",
            "--first-release",
            "--model",
            str(model),
            "--metadata",
            str(artifacts["metadata"]),
            "--vocabulary",
            str(artifacts["vocabulary"]),
            "--evaluation",
            str(artifacts["evaluation"]),
            "--review",
            str(review),
            "--runtime",
            str(artifacts["runtime"]),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    bundle = json.loads(output.read_text(encoding="utf-8"))
    assert exit_code == 0
    assert bundle["releaseVersion"] == "1.2.3"
    assert set(bundle["artifacts"]) == {
        "model",
        "metadata",
        "vocabulary",
        "evaluation",
        "review",
        "runtime",
    }
    assert json.loads(captured.out) == {
        "artifactCount": 6,
        "releaseVersion": "1.2.3",
        "status": "PASS",
    }
    assert captured.err == ""
    assert str(tmp_path) not in captured.out
    assert "private-model.onnx" not in captured.out


def test_governance_cli_errors_do_not_disclose_private_input_paths(
    tmp_path: Path, capsys
) -> None:
    data_root = tmp_path / "private-dataset"
    data_root.mkdir()
    samples = tmp_path / "private-malformed-samples.json"
    samples.write_text("not json", encoding="utf-8")
    output = tmp_path / "audit.json"

    exit_code = main(
        [
            "audit-duplicates",
            "--data-root",
            str(data_root),
            "--samples",
            str(samples),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "errorCode": "DUPLICATE_AUDIT_FAILED",
        "status": "ERROR",
    }
    assert str(tmp_path) not in captured.err
    assert "private-malformed-samples.json" not in captured.err
    assert not output.exists()


def test_lifecycle_cli_errors_are_sanitized(tmp_path: Path, capsys) -> None:
    data_root = tmp_path / "private-dataset"
    data_root.mkdir()
    index = tmp_path / "private-malformed-index.json"
    index.write_text("not json", encoding="utf-8")

    exit_code = main(
        [
            "lifecycle-inventory",
            "--root",
            str(data_root),
            "--index",
            str(index),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "errorCode": "LIFECYCLE_FAILED",
        "status": "ERROR",
    }
    assert str(tmp_path) not in captured.err
    assert "private-malformed-index.json" not in captured.err


def test_promotion_cli_errors_are_sanitized(tmp_path: Path, capsys) -> None:
    metadata = tmp_path / "private-malformed-metadata.json"
    metadata.write_text("not json", encoding="utf-8")
    evidence = _write_json(tmp_path / "private-evidence.json", {})
    output = tmp_path / "promotion.json"

    exit_code = main(
        [
            "promote",
            "--metadata",
            str(metadata),
            "--model",
            str(tmp_path / "private-model.onnx"),
            "--evidence",
            str(evidence),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "errorCode": "PROMOTION_FAILED",
        "status": "ERROR",
    }
    assert str(tmp_path) not in captured.err
    assert "private-malformed-metadata.json" not in captured.err
    assert not output.exists()


def test_release_bundle_cli_errors_are_sanitized(tmp_path: Path, capsys) -> None:
    malformed = tmp_path / "private-malformed-artifact.json"
    malformed.write_text("not json", encoding="utf-8")
    output = tmp_path / "release-bundle.json"

    exit_code = main(
        [
            "build-release-bundle",
            "--release-version",
            "1.2.3",
            "--first-release",
            "--model",
            str(malformed),
            "--metadata",
            str(malformed),
            "--vocabulary",
            str(malformed),
            "--evaluation",
            str(malformed),
            "--review",
            str(malformed),
            "--runtime",
            str(malformed),
            "--output",
            str(output),
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert captured.out == ""
    assert json.loads(captured.err) == {
        "errorCode": "RELEASE_BUNDLE_FAILED",
        "status": "ERROR",
    }
    assert str(tmp_path) not in captured.err
    assert "private-malformed-artifact.json" not in captured.err
    assert not output.exists()
