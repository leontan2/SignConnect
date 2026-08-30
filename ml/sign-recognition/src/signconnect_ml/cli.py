from __future__ import annotations

import argparse
from pathlib import Path


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="signconnect-ml")
    commands = root.add_subparsers(dest="command", required=True)

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
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
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
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
