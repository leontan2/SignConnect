from __future__ import annotations

import hashlib
import json
from pathlib import Path
import socket
from types import SimpleNamespace

import numpy as np
import pytest

from signconnect_ml.capture_workflow import (
    CaptureAuthorization,
    CaptureTake,
    CaptureWorkflow,
    CaptureWorkflowError,
)


SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64


def _evidence_root(private_root: Path) -> Path:
    return private_root.resolve().with_name(f"{private_root.name}-evidence")


def _write_evidence(path: Path, document: dict[str, object]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def valid_authorization(private_root: Path, **overrides: object) -> CaptureAuthorization:
    evidence_root = _evidence_root(private_root)
    governance_record_id = overrides.get(
        "governance_record_id", "governance_0123456789abcdef"
    )
    review_record_id = overrides.get(
        "sgsl_review_record_id", "review_0123456789abcdef"
    )
    consent_record_id = overrides.get(
        "consent_record_id", "consent_0123456789abcdef"
    )
    purpose_version = overrides.get("purpose_version", "1.0.0")
    consent_notice_version = overrides.get("consent_notice_version", "1.0.0")
    vocabulary_version = overrides.get("vocabulary_version", "1.0.0")
    consented_at = overrides.get("consented_at", "2026-08-30T01:00:00Z")
    retention_expires_at = overrides.get(
        "retention_expires_at", "2026-11-27T01:00:00Z"
    )
    reviewed_label_ids = overrides.get(
        "reviewed_label_ids", ("HELLO", "THANK_YOU")
    )
    governance_path = evidence_root / "governance.json"
    review_path = evidence_root / "sgsl-review.json"
    consent_path = evidence_root / "consent.json"
    governance_sha256 = _write_evidence(
        governance_path,
        {
            "consentNoticeVersion": consent_notice_version,
            "purposeVersion": purpose_version,
            "recordId": governance_record_id,
            "retentionDays": 90,
            "schemaVersion": 1,
            "status": overrides.pop("governance_artifact_status", "APPROVED"),
            "vocabularyVersion": vocabulary_version,
        },
    )
    review_sha256 = _write_evidence(
        review_path,
        {
            "recordId": review_record_id,
            "reviewedLabelIds": list(reviewed_label_ids),  # type: ignore[arg-type]
            "reviewerRole": "SGSL_FLUENT_DEAF_REVIEWER",
            "schemaVersion": 1,
            "status": overrides.pop("review_artifact_status", "APPROVED"),
            "vocabularyVersion": vocabulary_version,
        },
    )
    consent_sha256 = _write_evidence(
        consent_path,
        {
            "consentNoticeVersion": consent_notice_version,
            "consentedAt": consented_at,
            "permittedUses": ["MODEL_TRAINING", "MODEL_EVALUATION"],
            "purposeVersion": purpose_version,
            "recordId": consent_record_id,
            "retentionExpiresAt": retention_expires_at,
            "schemaVersion": 1,
            "status": overrides.pop("consent_artifact_status", "VERIFIED"),
            "vocabularyVersion": vocabulary_version,
            "withdrawalStatus": overrides.pop("withdrawal_artifact_status", "ACTIVE"),
        },
    )
    values: dict[str, object] = {
        "governance_record_id": governance_record_id,
        "governance_sha256": governance_sha256,
        "governance_evidence_path": governance_path.resolve(),
        "sgsl_review_record_id": review_record_id,
        "sgsl_review_sha256": review_sha256,
        "sgsl_review_evidence_path": review_path.resolve(),
        "consent_record_id": consent_record_id,
        "consent_sha256": consent_sha256,
        "consent_evidence_path": consent_path.resolve(),
        "consented_at": consented_at,
        "purpose_version": purpose_version,
        "consent_notice_version": consent_notice_version,
        "vocabulary_version": vocabulary_version,
        "retention_expires_at": retention_expires_at,
        "reviewed_label_ids": reviewed_label_ids,
    }
    values.update(overrides)
    return CaptureAuthorization(**values)  # type: ignore[arg-type]


def open_workflow(tmp_path, **authorization_overrides: object) -> CaptureWorkflow:
    return CaptureWorkflow(
        enabled=True,
        private_root=tmp_path.resolve(),
        export_id="capture_0123456789abcdef",
        signer_id="sgn_0123456789abcdef",
        authorization=valid_authorization(tmp_path, **authorization_overrides),
    )


def valid_take(landmarks: object | None = None, **overrides: object) -> CaptureTake:
    values: dict[str, object] = {
        "sample_id": "sample_0123456789abcdef",
        "label_id": "HELLO",
        "capture_timestamp": "2026-08-30T02:00:00Z",
        "handedness": "RIGHT",
        "capture_condition": {
            "lighting": "INDOOR",
            "background": "PLAIN",
            "cameraPosition": "LAPTOP",
            "occlusion": "NONE",
            "speed": "NATURAL",
            "distance": "NOMINAL",
            "scenario": "ISOLATED_SIGN",
        },
        "landmarks": np.zeros((30, 224), dtype=np.float32)
        if landmarks is None
        else landmarks,
    }
    values.update(overrides)
    return CaptureTake(**values)  # type: ignore[arg-type]


def test_capture_workflow_is_disabled_by_default() -> None:
    workflow = CaptureWorkflow()

    assert workflow.enabled is False
    assert workflow.pending_count == 0
    with pytest.raises(CaptureWorkflowError, match="disabled"):
        workflow.export()


def test_capture_workflow_rejects_unverified_enablement(tmp_path) -> None:
    with pytest.raises(CaptureWorkflowError, match="verified capture authorization artifacts"):
        CaptureWorkflow(
            enabled=True,
            private_root=tmp_path.resolve(),
            export_id="capture_0123456789abcdef",
            signer_id="sgn_0123456789abcdef",
            authorization=None,
        )


@pytest.mark.parametrize(
    ("artifact_override", "message"),
    (
        ({"governance_artifact_status": "PENDING"}, "governance evidence artifact"),
        ({"review_artifact_status": "REJECTED"}, "SGSL review evidence artifact"),
        ({"consent_artifact_status": "PENDING"}, "participant consent evidence artifact"),
        ({"withdrawal_artifact_status": "WITHDRAWN"}, "participant consent evidence artifact"),
    ),
)
def test_evidence_artifact_status_is_the_authorization_source_of_truth(
    tmp_path, artifact_override: dict[str, object], message: str
) -> None:
    authorization = valid_authorization(tmp_path, **artifact_override)

    with pytest.raises(CaptureWorkflowError, match=message):
        CaptureWorkflow(
            enabled=True,
            private_root=tmp_path.resolve(),
            export_id="capture_0123456789abcdef",
            signer_id="sgn_0123456789abcdef",
            authorization=authorization,
        )


def test_enablement_recomputes_artifact_digest_without_leaking_path_or_content(
    tmp_path, capsys, caplog
) -> None:
    authorization = valid_authorization(tmp_path)
    sensitive_path = authorization.governance_evidence_path
    sensitive_value = "private governance notes"
    sensitive_path.write_text(sensitive_value, encoding="utf-8")

    with pytest.raises(CaptureWorkflowError, match="artifact digest mismatch") as caught:
        CaptureWorkflow(
            enabled=True,
            private_root=tmp_path.resolve(),
            export_id="capture_0123456789abcdef",
            signer_id="sgn_0123456789abcdef",
            authorization=authorization,
        )

    error_text = str(caught.value)
    assert str(sensitive_path) not in error_text
    assert sensitive_value not in error_text
    assert capsys.readouterr() == ("", "")
    assert caplog.records == []


def test_export_rechecks_evidence_digest_before_writing_after_acceptance(tmp_path) -> None:
    workflow = open_workflow(tmp_path)
    workflow.accept(valid_take())
    consent_path = _evidence_root(tmp_path) / "consent.json"
    consent_path.write_bytes(consent_path.read_bytes() + b" ")

    with pytest.raises(CaptureWorkflowError, match="artifact digest mismatch"):
        workflow.export()

    assert workflow.pending_count == 1
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("governance_record_id", "", "governance evidence ID"),
        ("governance_sha256", "not-a-digest", "governance evidence digest"),
        ("sgsl_review_record_id", "", "SGSL review evidence ID"),
        ("sgsl_review_sha256", "not-a-digest", "SGSL review evidence digest"),
        ("consent_record_id", "", "participant consent evidence ID"),
        ("consent_sha256", "not-a-digest", "participant consent evidence digest"),
        ("purpose_version", "", "purpose version"),
        ("consent_notice_version", "", "consent notice version"),
        ("vocabulary_version", "", "vocabulary version"),
        ("reviewed_label_ids", (), "reviewed label IDs"),
    ],
)
def test_capture_workflow_requires_complete_digest_addressed_authorization(
    tmp_path, field: str, value: object, message: str
) -> None:
    authorization = valid_authorization(tmp_path, **{field: value})

    with pytest.raises(CaptureWorkflowError, match=message):
        CaptureWorkflow(
            enabled=True,
            private_root=tmp_path.resolve(),
            export_id="capture_0123456789abcdef",
            signer_id="sgn_0123456789abcdef",
            authorization=authorization,
        )


@pytest.mark.parametrize(
    ("private_root", "export_id", "signer_id", "message"),
    [
        (None, "capture_0123456789abcdef", "sgn_0123456789abcdef", "private root"),
        (Path("relative-root"), "capture_0123456789abcdef", "sgn_0123456789abcdef", "absolute"),
        (None, "", "sgn_0123456789abcdef", "export ID"),
        (None, "capture_0123456789abcdef", "person@example.com", "signer ID"),
    ],
)
def test_enabled_workflow_requires_explicit_private_root_and_pseudonymous_ids(
    tmp_path,
    private_root: Path | None,
    export_id: str,
    signer_id: str,
    message: str,
) -> None:
    resolved_root = tmp_path.resolve() if private_root is None else private_root
    if private_root is None and message == "private root":
        resolved_root = None

    with pytest.raises(CaptureWorkflowError, match=message):
        CaptureWorkflow(
            enabled=True,
            private_root=resolved_root,
            export_id=export_id,
            signer_id=signer_id,
            authorization=valid_authorization(tmp_path),
        )


def test_accepts_a_contract_valid_in_memory_landmark_take(tmp_path) -> None:
    workflow = open_workflow(tmp_path)

    sample_id = workflow.accept(valid_take())

    assert sample_id == "sample_0123456789abcdef"
    assert workflow.pending_count == 1


@pytest.mark.parametrize(
    "landmarks",
    [
        np.zeros((29, 224), dtype=np.float32),
        np.zeros((30, 223), dtype=np.float32),
        np.full((30, 224), np.nan, dtype=np.float32),
        np.full((30, 224), np.inf, dtype=np.float32),
    ],
)
def test_rejects_landmarks_outside_the_finite_30_by_224_contract(
    tmp_path, landmarks: np.ndarray
) -> None:
    workflow = open_workflow(tmp_path)

    with pytest.raises(CaptureWorkflowError, match=r"finite \[30,224\]"):
        workflow.accept(valid_take(landmarks))

    assert workflow.pending_count == 0


def test_rejects_a_label_not_bound_to_the_verified_sgsl_review(tmp_path) -> None:
    workflow = open_workflow(tmp_path)

    with pytest.raises(CaptureWorkflowError, match="not in the reviewed SGSL vocabulary"):
        workflow.accept(valid_take(label_id="UNREVIEWED_SIGN"))

    assert workflow.pending_count == 0


@pytest.mark.parametrize(
    ("take_overrides", "message"),
    [
        ({"sample_id": "alice@example.com"}, "sample ID"),
        ({"handedness": "AMBIDEXTROUS"}, "handedness"),
        (
            {
                "capture_condition": {
                    "lighting": "INDOOR",
                    "background": "PLAIN",
                    "cameraPosition": "LAPTOP",
                    "occlusion": "NONE",
                    "speed": "NATURAL",
                    "distance": "NOMINAL",
                    "scenario": "ISOLATED_SIGN",
                    "rawVideo": "forbidden.mp4",
                }
            },
            "capture condition",
        ),
    ],
)
def test_rejects_noncontract_take_metadata(
    tmp_path, take_overrides: dict[str, object], message: str
) -> None:
    workflow = open_workflow(tmp_path)

    with pytest.raises(CaptureWorkflowError, match=message):
        workflow.accept(valid_take(**take_overrides))

    assert workflow.pending_count == 0


def test_rejects_duplicate_sample_ids_instead_of_overwriting(tmp_path) -> None:
    workflow = open_workflow(tmp_path)
    workflow.accept(valid_take())

    with pytest.raises(CaptureWorkflowError, match="duplicate sample ID"):
        workflow.accept(valid_take(landmarks=np.ones((30, 224), dtype=np.float32)))

    assert workflow.pending_count == 1


def test_discard_removes_only_the_selected_pending_take(tmp_path) -> None:
    workflow = open_workflow(tmp_path)
    workflow.accept(valid_take())
    workflow.accept(
        valid_take(
            sample_id="sample_fedcba9876543210",
            label_id="THANK_YOU",
        )
    )

    assert workflow.discard("sample_0123456789abcdef") is True
    assert workflow.discard("sample_0123456789abcdef") is False
    assert workflow.pending_count == 1


def test_cancel_clears_unexported_takes_and_closes_without_writing(tmp_path) -> None:
    private_root = tmp_path.resolve()
    workflow = open_workflow(private_root)
    workflow.accept(valid_take())

    workflow.cancel()
    workflow.cancel()

    assert workflow.enabled is False
    assert workflow.pending_count == 0
    assert list(private_root.iterdir()) == []
    with pytest.raises(CaptureWorkflowError, match="cancelled"):
        workflow.accept(valid_take())
    with pytest.raises(CaptureWorkflowError, match="cancelled"):
        workflow.export()


def test_export_writes_only_accepted_landmarks_and_minimal_manifest_fragment(
    tmp_path,
) -> None:
    landmarks = np.arange(30 * 224, dtype=np.float32).reshape(30, 224) / 1000.0
    workflow = open_workflow(tmp_path)
    workflow.accept(valid_take(landmarks))

    receipt = workflow.export()

    export_root = tmp_path.resolve() / "capture_0123456789abcdef"
    artifact_path = export_root / "landmarks" / "sample_0123456789abcdef.npz"
    manifest_path = export_root / "manifest-fragment.json"
    assert receipt.export_root == export_root
    assert receipt.manifest_path == manifest_path
    assert receipt.sample_count == 1
    assert receipt.manifest_sha256 == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    with np.load(artifact_path, allow_pickle=False) as archive:
        assert set(archive.files) == {"features"}
        np.testing.assert_array_equal(archive["features"], landmarks)

    from signconnect_ml.dataset import LandmarkDataset

    downstream_manifest = SimpleNamespace(
        path=manifest_path,
        samples=(
            SimpleNamespace(
                sample_id="sample_0123456789abcdef",
                path="landmarks/sample_0123456789abcdef.npz",
                artifact_sha256=hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
                label_id="HELLO",
            ),
        ),
        classes=("HELLO",),
        label_outcome=lambda label_id: "SIGN",
    )
    downstream_features, downstream_target = LandmarkDataset(
        downstream_manifest, ("sample_0123456789abcdef",)
    )[0]
    np.testing.assert_array_equal(downstream_features.numpy(), landmarks)
    assert int(downstream_target) == 0

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    evidence_root = _evidence_root(tmp_path)
    assert manifest["authorization"] == {
        "consentNoticeVersion": "1.0.0",
        "consentRecordId": "consent_0123456789abcdef",
        "consentSha256": hashlib.sha256(
            (evidence_root / "consent.json").read_bytes()
        ).hexdigest(),
        "governanceRecordId": "governance_0123456789abcdef",
        "governanceSha256": hashlib.sha256(
            (evidence_root / "governance.json").read_bytes()
        ).hexdigest(),
        "purposeVersion": "1.0.0",
        "sgslReviewRecordId": "review_0123456789abcdef",
        "sgslReviewSha256": hashlib.sha256(
            (evidence_root / "sgsl-review.json").read_bytes()
        ).hexdigest(),
        "vocabularyVersion": "1.0.0",
    }
    assert manifest["samples"][0]["sampleId"] == "sample_0123456789abcdef"
    assert manifest["samples"][0]["signerId"] == "sgn_0123456789abcdef"
    assert manifest["samples"][0]["labelId"] == "HELLO"
    assert manifest["samples"][0]["language"] == "sls"
    assert manifest["samples"][0]["landmarkArtifact"] == {
        "mediaType": "application/x-npz",
        "path": "landmarks/sample_0123456789abcdef.npz",
        "sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
    }
    output_text = manifest_path.read_text(encoding="utf-8").lower()
    assert all(term not in output_text for term in ("video", "audio", "pixel", "base64"))
    assert sorted(
        path.relative_to(export_root).as_posix()
        for path in export_root.rglob("*")
        if path.is_file()
    ) == [
        "landmarks/sample_0123456789abcdef.npz",
        "manifest-fragment.json",
    ]


def test_export_is_deterministic_copies_input_and_uses_no_network_or_tensor_logs(
    tmp_path, monkeypatch, capsys, caplog
) -> None:
    original = np.full((30, 224), 0.125, dtype=np.float32)
    first = open_workflow(tmp_path / "first")
    first_take = valid_take(original)
    first.accept(first_take)
    original.fill(999.0)
    first_take.capture_condition["rawVideo"] = "forbidden-after-accept.mp4"
    second = open_workflow(tmp_path / "second")
    second.accept(valid_take(np.full((30, 224), 0.125, dtype=np.float32)))

    def network_forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("capture export must not open a network socket")

    monkeypatch.setattr(socket, "socket", network_forbidden)
    first_receipt = first.export()
    second_receipt = second.export()

    first_artifact = first_receipt.export_root / "landmarks/sample_0123456789abcdef.npz"
    second_artifact = second_receipt.export_root / "landmarks/sample_0123456789abcdef.npz"
    assert first_receipt.manifest_sha256 == second_receipt.manifest_sha256
    assert first_receipt.manifest_path.read_bytes() == second_receipt.manifest_path.read_bytes()
    assert first_artifact.read_bytes() == second_artifact.read_bytes()
    with np.load(first_artifact, allow_pickle=False) as archive:
        assert float(archive["features"][0, 0]) == 0.125
    assert caplog.records == []
    assert capsys.readouterr() == ("", "")


def test_export_failure_leaves_no_partial_files_and_can_be_safely_cancelled(
    tmp_path, monkeypatch
) -> None:
    workflow = open_workflow(tmp_path)
    workflow.accept(valid_take())
    original_write_bytes = Path.write_bytes

    def fail_manifest_write(path: Path, data: bytes) -> int:
        if path.name == "manifest-fragment.json":
            raise OSError("simulated local disk failure")
        return original_write_bytes(path, data)

    monkeypatch.setattr(Path, "write_bytes", fail_manifest_write)
    with pytest.raises(OSError, match="simulated local disk failure"):
        workflow.export()

    assert workflow.pending_count == 1
    assert list(tmp_path.iterdir()) == []
    workflow.cancel()
    assert workflow.pending_count == 0
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("authorization_overrides", "capture_timestamp", "message"),
    [
        (
            {"retention_expires_at": "2026-11-29T02:00:01Z"},
            "2026-08-30T02:00:00Z",
            "90 days",
        ),
        (
            {"consented_at": "2026-08-30T03:00:00Z"},
            "2026-08-30T02:00:00Z",
            "consent must precede capture",
        ),
    ],
)
def test_rejects_takes_outside_the_consent_and_90_day_retention_window(
    tmp_path,
    authorization_overrides: dict[str, object],
    capture_timestamp: str,
    message: str,
) -> None:
    workflow = open_workflow(tmp_path, **authorization_overrides)

    with pytest.raises(CaptureWorkflowError, match=message):
        workflow.accept(valid_take(capture_timestamp=capture_timestamp))

    assert workflow.pending_count == 0
