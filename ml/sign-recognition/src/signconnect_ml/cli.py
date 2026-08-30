from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="signconnect-ml")
    commands = root.add_subparsers(dest="command", required=True)

    preprocessing = commands.add_parser("preprocess")
    preprocessing.add_argument("--input", required=True, type=Path)
    preprocessing.add_argument("--output", required=True, type=Path)
    preprocessing.add_argument("--maximum-frame-gap-ms", type=float, default=200.0)

    synthetic = commands.add_parser("generate-synthetic")
    synthetic.add_argument("--output", required=True, type=Path)
    synthetic.add_argument("--seed", type=int, default=20260830)
    synthetic.add_argument("--signers", type=int, default=6)

    training = commands.add_parser("train")
    training.add_argument("--config", required=True, type=Path)

    evaluation = commands.add_parser("evaluate")
    evaluation.add_argument("--checkpoint", required=True, type=Path)
    evaluation.add_argument("--manifest", required=True, type=Path)
    evaluation.add_argument("--split-file", required=True, type=Path)
    evaluation.add_argument("--split", choices=("train", "validation", "test"), default="test")
    evaluation.add_argument("--output", required=True, type=Path)
    evaluation.add_argument("--batch-size", type=int, default=32)
    evaluation.add_argument("--false-final-threshold", type=float, default=0.8)

    exporting = commands.add_parser("export")
    exporting.add_argument("--checkpoint", required=True, type=Path)
    exporting.add_argument("--manifest", required=True, type=Path)
    exporting.add_argument("--output", required=True, type=Path)
    exporting.add_argument("--claim-genuine-sgsl", action="store_true")
    exporting.add_argument("--verify-parity", action="store_true")

    asl_research = commands.add_parser("prepare-asl-research")
    asl_research.add_argument("--source-root", required=True, type=Path)
    asl_research.add_argument("--checkpoint", required=True, type=Path)
    asl_research.add_argument("--vocabulary", required=True, type=Path)
    asl_research.add_argument("--output-directory", required=True, type=Path)

    inventory = commands.add_parser("lifecycle-inventory")
    inventory.add_argument("--root", required=True, type=Path)
    inventory.add_argument("--index", required=True, type=Path)
    inventory.add_argument("--signer-id", action="append", default=[])
    inventory.add_argument("--sample-id", action="append", default=[])

    expiry = commands.add_parser("lifecycle-expiry")
    expiry.add_argument("--root", required=True, type=Path)
    expiry.add_argument("--index", required=True, type=Path)
    expiry.add_argument("--as-of", required=True)

    deletion = commands.add_parser("lifecycle-plan-deletion")
    deletion.add_argument("--root", required=True, type=Path)
    deletion.add_argument("--index", required=True, type=Path)
    deletion.add_argument("--signer-id", action="append", default=[])
    deletion.add_argument("--sample-id", action="append", default=[])
    deletion.add_argument(
        "--reason", required=True, choices=("WITHDRAWAL", "RETENTION_EXPIRED")
    )
    deletion.add_argument("--planned-at", required=True)

    duplicate_audit = commands.add_parser("audit-duplicates")
    duplicate_audit.add_argument("--data-root", required=True, type=Path)
    duplicate_audit.add_argument("--samples", required=True, type=Path)
    duplicate_audit.add_argument("--output", required=True, type=Path)
    duplicate_audit.add_argument(
        "--near-duplicate-threshold", type=float, default=0.9999
    )

    promotion = commands.add_parser("promote")
    promotion.add_argument("--metadata", required=True, type=Path)
    promotion.add_argument("--model", required=True, type=Path)
    promotion.add_argument("--evidence", required=True, type=Path)
    promotion.add_argument("--output", required=True, type=Path)

    release = commands.add_parser("build-release-bundle")
    release.add_argument("--release-version", required=True)
    release.add_argument("--first-release", action="store_true")
    release.add_argument("--previous-known-good-version")
    release.add_argument("--model", required=True, type=Path)
    release.add_argument("--metadata", required=True, type=Path)
    release.add_argument("--vocabulary", required=True, type=Path)
    release.add_argument("--evaluation", required=True, type=Path)
    release.add_argument("--review", required=True, type=Path)
    release.add_argument("--runtime", required=True, type=Path)
    release.add_argument("--existing-bundle", type=Path)
    release.add_argument("--output", required=True, type=Path)
    return root


def _safe_error(error_code: str) -> int:
    print(
        json.dumps({"errorCode": error_code, "status": "ERROR"}, sort_keys=True),
        file=sys.stderr,
    )
    return 2


def _run_lifecycle(args: argparse.Namespace) -> int:
    from .lifecycle import inventory_artifacts, plan_deletion, report_expiry

    try:
        artifact_index = json.loads(args.index.read_text(encoding="utf-8"))
        if args.command == "lifecycle-inventory":
            report = inventory_artifacts(
                args.root,
                artifact_index,
                signer_ids=args.signer_id,
                sample_ids=args.sample_id,
            )
            result = {
                "artifactIds": list(report.artifact_ids),
                "existingCount": report.existing_count,
                "missingCount": report.missing_count,
                "status": "PASS",
            }
        elif args.command == "lifecycle-expiry":
            report = report_expiry(
                args.root,
                artifact_index,
                as_of=datetime.fromisoformat(args.as_of.replace("Z", "+00:00")),
            )
            result = {
                "expiredArtifactIds": list(report.expired_artifact_ids),
                "overdueArtifactIds": list(report.overdue_artifact_ids),
                "status": "PASS",
            }
        else:
            plan = plan_deletion(
                args.root,
                artifact_index,
                signer_ids=args.signer_id,
                sample_ids=args.sample_id,
                reason=args.reason,
                planned_at=datetime.fromisoformat(
                    args.planned_at.replace("Z", "+00:00")
                ),
            )
            result = {
                "artifactIds": list(plan.artifact_ids),
                "dryRun": plan.dry_run,
                "reason": plan.reason,
                "status": "PASS",
            }
    except (OSError, ValueError):
        return _safe_error("LIFECYCLE_FAILED")
    print(json.dumps(result, sort_keys=True))
    return 0


def _run_duplicate_audit(args: argparse.Namespace) -> int:
    from .duplicate_audit import DuplicateAuditError, audit_duplicate_leakage

    try:
        samples = json.loads(args.samples.read_text(encoding="utf-8"))
        report = audit_duplicate_leakage(
            data_root=args.data_root,
            samples=samples,
            near_duplicate_threshold=args.near_duplicate_threshold,
        )

        def identity_document(identity: object) -> dict[str, object]:
            return {
                "sampleId": getattr(identity, "sample_id"),
                "signerId": getattr(identity, "signer_id"),
                "split": getattr(identity, "split"),
            }

        document = {
            "status": report.status,
            "sampleCount": report.sample_count,
            "findings": [
                {
                    "kind": finding.kind,
                    "left": identity_document(finding.left),
                    "right": identity_document(finding.right),
                    "similarity": finding.similarity,
                }
                for finding in report.findings
            ],
            "fingerprints": [
                {
                    "sampleId": fingerprint.sample_id,
                    "signerId": fingerprint.signer_id,
                    "split": fingerprint.split,
                    "tensorSha256": fingerprint.tensor_sha256,
                    "nearSha256": fingerprint.near_sha256,
                }
                for fingerprint in report.fingerprints
            ],
        }
        args.output.write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except (DuplicateAuditError, json.JSONDecodeError, OSError, UnicodeError):
        return _safe_error("DUPLICATE_AUDIT_FAILED")
    print(
        json.dumps(
            {
                "findingCount": len(report.findings),
                "sampleCount": report.sample_count,
                "status": report.status,
            },
            sort_keys=True,
        )
    )
    return 0 if report.status == "PASS" else 1


def _run_promotion(args: argparse.Namespace) -> int:
    from .promotion import apply_promotion_evidence

    try:
        metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
        evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
        assessment = apply_promotion_evidence(metadata, args.model, evidence)
        args.output.write_text(
            json.dumps(assessment.metadata, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except (OSError, ValueError):
        return _safe_error("PROMOTION_FAILED")
    print(
        json.dumps(
            {
                "approved": assessment.approved,
                "blockerCount": len(assessment.blockers),
                "status": "APPROVED" if assessment.approved else "BLOCKED",
            },
            sort_keys=True,
        )
    )
    return 0 if assessment.approved else 1


def _run_release_bundle(args: argparse.Namespace) -> int:
    from .release_bundle import ReleaseBundleError, build_release_bundle

    try:
        existing_bundle = (
            json.loads(args.existing_bundle.read_text(encoding="utf-8"))
            if args.existing_bundle is not None
            else None
        )
        bundle = build_release_bundle(
            release_version=args.release_version,
            first_release=args.first_release,
            previous_known_good_version=args.previous_known_good_version,
            model_path=args.model,
            metadata_path=args.metadata,
            vocabulary_path=args.vocabulary,
            evaluation_path=args.evaluation,
            review_path=args.review,
            runtime_path=args.runtime,
            existing_bundle=existing_bundle,
        )
        args.output.write_text(
            json.dumps(bundle, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except (ReleaseBundleError, json.JSONDecodeError, OSError, UnicodeError):
        return _safe_error("RELEASE_BUNDLE_FAILED")
    print(
        json.dumps(
            {
                "artifactCount": len(bundle["artifacts"]),
                "releaseVersion": bundle["releaseVersion"],
                "status": "PASS",
            },
            sort_keys=True,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.command == "preprocess":
        from .preprocessing import preprocess_file

        print(
            preprocess_file(
                args.input,
                args.output,
                maximum_frame_gap_ms=args.maximum_frame_gap_ms,
            )
        )
        return 0
    if args.command == "generate-synthetic":
        from .synthetic import generate_non_production_synthetic

        path = generate_non_production_synthetic(args.output, args.seed, args.signers)
        print(path)
        return 0
    if args.command == "train":
        from .config import load_config
        from .training import train

        print(train(load_config(args.config)))
        return 0
    if args.command == "evaluate":
        from .training import evaluate_checkpoint

        print(
            evaluate_checkpoint(
                args.checkpoint,
                args.manifest,
                args.split_file,
                args.output,
                args.split,
                args.batch_size,
                args.false_final_threshold,
            )
        )
        return 0
    if args.command == "export":
        from .exporting import export_onnx

        model, metadata = export_onnx(
            args.checkpoint,
            args.manifest,
            args.output,
            args.claim_genuine_sgsl,
            args.verify_parity,
        )
        print(model)
        print(metadata)
        return 0
    if args.command == "prepare-asl-research":
        from .openhands_asl import export_openhands_asl_research_model

        model, metadata = export_openhands_asl_research_model(
            source_root=args.source_root,
            checkpoint_path=args.checkpoint,
            vocabulary_path=args.vocabulary,
            output_directory=args.output_directory,
        )
        print(model)
        print(metadata)
        return 0
    if args.command in {
        "lifecycle-inventory",
        "lifecycle-expiry",
        "lifecycle-plan-deletion",
    }:
        return _run_lifecycle(args)
    if args.command == "audit-duplicates":
        return _run_duplicate_audit(args)
    if args.command == "promote":
        return _run_promotion(args)
    if args.command == "build-release-bundle":
        return _run_release_bundle(args)
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
