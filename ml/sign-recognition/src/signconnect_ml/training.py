from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import TrainConfig, config_sha256, training_config_document
from .constants import FEATURE_CONTRACT, OUT_OF_VOCABULARY
from .dataset import LandmarkDataset
from .evaluation import evaluate_model, metrics_document, write_evaluation
from .manifest import load_manifest, require_training_authorization
from .models import build_model
from .reproducibility import set_global_determinism
from .splits import create_signer_grouped_split, split_sha256, write_split


_CHECKPOINT_ERROR = "checkpoint does not satisfy the SignConnect model contract"
_CHECKPOINT_KEYS_V1 = {
    "schema_version",
    "state_dict",
    "architecture",
    "hidden_size",
    "dropout",
    "classes",
    "seed",
    "manifest_sha256",
    "dataset_id",
    "provenance_status",
    "history",
    "selected_epoch",
    "evaluation_split",
    "evaluation",
    "split_sha256",
    "test_signer_count",
    "minimum_confidence",
    "config",
}
_CHECKPOINT_KEYS_V2 = _CHECKPOINT_KEYS_V1 | {
    "reproducibility",
    "threshold_selection",
}
_CONFIG_KEYS_V1 = {
    "seed",
    "model",
    "epochs",
    "batch_size",
    "learning_rate",
    "hidden_size",
    "dropout",
    "false_final_threshold",
}
_CONFIG_KEYS_V2 = _CONFIG_KEYS_V1 | {
    "input_contract_version",
    "augmentation_policy",
    "optimizer_name",
    "learning_rate_schedule",
    "threshold_candidates",
}
_LABEL = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_DATASET_ID = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_ROBUSTNESS_SLICE_VALUES = {
    "lighting": ("LOW", "INDOOR", "DAYLIGHT", "MIXED"),
    "cameraDistance": ("NEAR", "NOMINAL", "FAR"),
    "signingSpeed": ("SLOW", "NATURAL", "FAST"),
    "handedness": ("LEFT", "RIGHT", "TWO_HANDED", "NOT_APPLICABLE", "UNKNOWN"),
    "occlusion": ("NONE", "PARTIAL"),
    "behaviorScenario": (
        "ISOLATED_SIGN",
        "INCOMPLETE_GESTURE",
        "HELD_SIGN",
        "REPEATED_SIGN",
        "IDLE",
        "TRANSITION",
        "UNKNOWN_GESTURE",
        "NATURAL_MOVEMENT",
    ),
}


@dataclass(frozen=True)
class ThresholdSelection:
    selected_threshold: float
    selected_metrics: object
    evidence: dict


def select_validation_threshold(
    model,
    validation_data: LandmarkDataset,
    manifest,
    batch_size: int,
    candidates: tuple[float, ...],
) -> ThresholdSelection:
    if (
        type(candidates) is not tuple
        or not candidates
        or tuple(sorted(set(candidates))) != candidates
        or any(
            type(value) is not float or not 0.0 <= value <= 1.0
            for value in candidates
        )
    ):
        raise ValueError("threshold candidates must be unique ascending floats in [0,1]")

    evaluated = [
        (
            threshold,
            evaluate_model(
                model,
                validation_data,
                manifest,
                batch_size,
                threshold,
            ),
        )
        for threshold in candidates
    ]
    selected_threshold, selected_metrics = min(
        evaluated,
        key=lambda item: (
            item[1].false_final_rate,
            item[1].rejection.rejection_rate,
            item[0],
        ),
    )
    evidence = {
        "split": "validation",
        "objective": "minimize_false_final_rate_then_rejection_rate",
        "candidates": list(candidates),
        "tieBreak": "lowest_threshold",
        "selectedThreshold": selected_threshold,
        "results": [
            {
                "threshold": threshold,
                "falseFinalRate": metrics.false_final_rate,
                "rejectionRate": metrics.rejection.rejection_rate,
            }
            for threshold, metrics in evaluated
        ],
    }
    return ThresholdSelection(selected_threshold, selected_metrics, evidence)


def build_reproducibility_evidence(
    config: TrainConfig,
    *,
    package_root: Path | None = None,
) -> dict:
    package_root = (
        Path(__file__).resolve().parents[2]
        if package_root is None
        else Path(package_root).resolve()
    )
    lockfile = package_root / "uv.lock"
    if not lockfile.is_file():
        raise RuntimeError("uv.lock is required to record training dependencies")
    return {
        "schemaVersion": 1,
        "configSha256": config_sha256(config),
        "dependencyLock": {
            "file": "uv.lock",
            "sha256": hashlib.sha256(lockfile.read_bytes()).hexdigest(),
        },
        "sourceControl": _source_control_provenance(package_root),
    }


def _source_control_provenance(package_root: Path) -> dict:
    repository = next(
        (
            candidate
            for candidate in (package_root, *package_root.parents)
            if (candidate / ".git").exists()
        ),
        None,
    )
    if repository is None:
        return _unavailable_source_control()
    try:
        scope = package_root.resolve().relative_to(repository.resolve()).as_posix()
    except ValueError:
        return _unavailable_source_control()
    base_command = [
        "git",
        "-c",
        f"safe.directory={repository.as_posix()}",
        "-C",
        str(repository),
    ]
    try:
        commit = subprocess.run(
            [*base_command, "rev-parse", "--verify", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip().lower()
        tracked_diff = subprocess.run(
            [*base_command, "diff", "--binary", "--no-ext-diff", "HEAD", "--", scope],
            check=True,
            capture_output=True,
            timeout=5,
        ).stdout
        untracked_output = subprocess.run(
            [
                *base_command,
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                scope,
            ],
            check=True,
            capture_output=True,
            timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return _unavailable_source_control()
    if re.fullmatch(r"[a-f0-9]{40,64}", commit) is None:
        return _unavailable_source_control()
    try:
        untracked_paths = tuple(
            item.decode("utf-8")
            for item in untracked_output.split(b"\0")
            if item
        )
        untracked_state_sha256, untracked_content_sha256 = (
            _untracked_source_digests(repository, package_root, untracked_paths)
        )
    except (OSError, UnicodeError, ValueError):
        return _unavailable_source_control()
    tracked_changes_sha256 = hashlib.sha256(tracked_diff).hexdigest()
    dirty = bool(tracked_diff) or bool(untracked_paths)
    return {
        "commit": commit,
        "dirty": dirty,
        "trackedChangesSha256": tracked_changes_sha256,
        "untrackedFileCount": len(untracked_paths),
        "untrackedStateSha256": untracked_state_sha256,
        "untrackedContentSha256": untracked_content_sha256,
    }


def _untracked_source_digests(
    repository: Path,
    package_root: Path,
    relative_paths: tuple[str, ...],
) -> tuple[str, str]:
    content_digests: list[bytes] = []
    state_records: list[bytes] = []
    repository = repository.resolve()
    package_root = package_root.resolve()
    for relative_path in relative_paths:
        candidate = repository / relative_path
        resolved = candidate.resolve()
        if not resolved.is_relative_to(package_root) or candidate.is_symlink():
            raise ValueError("untracked source entry is not a local regular file")
        stat = candidate.stat()
        if not candidate.is_file():
            raise ValueError("untracked source entry is not a local regular file")
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        content_digest = digest.digest()
        content_digests.append(content_digest)
        path_digest = hashlib.sha256(
            relative_path.replace("\\", "/").encode("utf-8")
        ).digest()
        state_records.append(
            path_digest + stat.st_size.to_bytes(16, byteorder="big") + content_digest
        )
    return (
        hashlib.sha256(b"".join(sorted(state_records))).hexdigest(),
        hashlib.sha256(b"".join(sorted(content_digests))).hexdigest(),
    )


def _unavailable_source_control() -> dict:
    return {
        "commit": None,
        "dirty": None,
        "trackedChangesSha256": None,
        "untrackedFileCount": None,
        "untrackedStateSha256": None,
        "untrackedContentSha256": None,
    }


def train(config: TrainConfig) -> Path:
    import torch

    set_global_determinism(config.seed)
    manifest = load_manifest(config.manifest)
    require_training_authorization(manifest)
    if config.input_contract_version != manifest.feature_layout_version:
        raise ValueError("training input contract differs from the dataset manifest")
    if (
        config.augmentation_policy != "none"
        or config.optimizer_name != "adam"
        or config.learning_rate_schedule != "constant"
        or (
            config.threshold_candidates
            and config.false_final_threshold not in config.threshold_candidates
        )
    ):
        raise ValueError("unsupported training reproducibility declaration")
    split = create_signer_grouped_split(manifest, config.seed)
    config.output_dir.mkdir(parents=True, exist_ok=True)
    split_path = config.output_dir / "split.json"
    write_split(split_path, split)

    training_data = LandmarkDataset(manifest, split.train)
    validation_data = LandmarkDataset(manifest, split.validation)
    model = build_model(config.model, len(manifest.classes), config.hidden_size, config.dropout)
    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    criterion = torch.nn.CrossEntropyLoss()
    generator = torch.Generator().manual_seed(config.seed)
    loader = torch.utils.data.DataLoader(
        training_data,
        batch_size=config.batch_size,
        shuffle=True,
        generator=generator,
        num_workers=0,
    )

    history = []
    best_validation_key = None
    best_epoch = None
    best_validation = None
    best_state_dict = None
    for epoch in range(config.epochs):
        model.train()
        total_loss = 0.0
        sample_count = 0
        for features, targets in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(features)
            loss = criterion(logits, targets)
            loss.backward()
            optimizer.step()
            total_loss += float(loss.detach()) * targets.shape[0]
            sample_count += targets.shape[0]
        validation = evaluate_model(
            model,
            validation_data,
            manifest,
            config.batch_size,
            config.false_final_threshold,
        )
        history.append(
            {
                "epoch": epoch + 1,
                "trainingLoss": total_loss / sample_count,
                "validationMacroF1": validation.macro_f1,
                "validationFalseFinalRate": validation.false_final_rate,
            }
        )

        validation_key = (validation.macro_f1, -validation.false_final_rate)
        if best_validation_key is None or validation_key > best_validation_key:
            best_validation_key = validation_key
            best_epoch = epoch + 1
            best_validation = validation
            best_state_dict = {
                name: value.detach().clone()
                for name, value in model.state_dict().items()
            }

    if best_epoch is None or best_validation is None or best_state_dict is None:
        raise RuntimeError("training did not produce a validation checkpoint")
    model.load_state_dict(best_state_dict, strict=True)

    threshold_selection = select_validation_threshold(
        model,
        validation_data,
        manifest,
        config.batch_size,
        config.threshold_candidates or (config.false_final_threshold,),
    )

    selection_evaluation = _bind_evaluation_to_state(
        metrics_document(threshold_selection.selected_metrics, manifest, "validation"),
        model.state_dict(),
        torch,
    )
    write_evaluation(config.output_dir / "validation-selection.json", selection_evaluation)
    checkpoint_path = config.output_dir / "checkpoint.pt"
    torch.save(
        {
            "schema_version": 2,
            "state_dict": model.state_dict(),
            "architecture": config.model,
            "hidden_size": config.hidden_size,
            "dropout": config.dropout,
            "classes": list(manifest.classes),
            "seed": config.seed,
            "manifest_sha256": manifest.sha256,
            "dataset_id": manifest.dataset_id,
            "provenance_status": manifest.provenance_status,
            "history": history,
            "selected_epoch": best_epoch,
            "evaluation_split": "validation",
            "evaluation": selection_evaluation,
            "split_sha256": split_sha256(split),
            "test_signer_count": manifest.test_signer_count,
            "minimum_confidence": threshold_selection.selected_threshold,
            "config": training_config_document(config),
            "reproducibility": build_reproducibility_evidence(config),
            "threshold_selection": threshold_selection.evidence,
        },
        checkpoint_path,
    )
    return checkpoint_path


def load_checkpoint_model(
    checkpoint_path: str | Path,
    *,
    allow_pending_final_test: bool = False,
):
    import torch

    try:
        checkpoint = torch.load(
            Path(checkpoint_path),
            map_location="cpu",
            weights_only=True,
        )
    except Exception:
        # PyTorch's unpickling diagnostics can include attacker-controlled global
        # names. Keep this trust-boundary error stable and free of checkpoint data.
        raise ValueError("checkpoint could not be loaded safely") from None
    try:
        valid_checkpoint = _valid_checkpoint(checkpoint, torch)
    except Exception:
        valid_checkpoint = False
    if not valid_checkpoint:
        raise ValueError(_CHECKPOINT_ERROR)
    if checkpoint["evaluation_split"] != "test" and not allow_pending_final_test:
        raise ValueError("checkpoint final-test evaluation has not been completed")
    model = build_model(
        checkpoint["architecture"],
        len(checkpoint["classes"]),
        checkpoint["hidden_size"],
        checkpoint["dropout"],
    )
    try:
        model.load_state_dict(checkpoint["state_dict"], strict=True)
    except (RuntimeError, TypeError, ValueError):
        raise ValueError(_CHECKPOINT_ERROR) from None
    model.eval()
    return model, checkpoint


def _valid_checkpoint(checkpoint, torch) -> bool:
    if type(checkpoint) is not dict:
        return False
    schema_version = checkpoint.get("schema_version")
    if type(schema_version) is not int:
        return False
    if schema_version == 1:
        expected_keys = _CHECKPOINT_KEYS_V1
    elif schema_version == 2:
        expected_keys = _CHECKPOINT_KEYS_V2
    else:
        return False
    if set(checkpoint) != expected_keys:
        return False
    architecture = checkpoint["architecture"]
    if type(architecture) is not str or architecture not in {"tcn", "gru"}:
        return False
    if not _integer(checkpoint["hidden_size"], 1, 4096):
        return False
    if not _number(checkpoint["dropout"], 0.0, 1.0, maximum_inclusive=False):
        return False
    classes = checkpoint["classes"]
    if (
        type(classes) is not list
        or not 2 <= len(classes) <= 4096
        or any(type(label) is not str or _LABEL.fullmatch(label) is None for label in classes)
        or classes[0] != "NO_SIGN"
        or len(classes) != len(set(classes))
    ):
        return False
    if not _integer(checkpoint["seed"], 0, 2**63 - 1):
        return False
    if type(checkpoint["manifest_sha256"]) is not str or _SHA256.fullmatch(
        checkpoint["manifest_sha256"]
    ) is None:
        return False
    if type(checkpoint["split_sha256"]) is not str or _SHA256.fullmatch(
        checkpoint["split_sha256"]
    ) is None:
        return False
    if type(checkpoint["dataset_id"]) is not str or _DATASET_ID.fullmatch(
        checkpoint["dataset_id"]
    ) is None:
        return False
    if (
        type(checkpoint["provenance_status"]) is not str
        or checkpoint["provenance_status"]
        not in {"NON_PRODUCTION_SYNTHETIC", "ATTESTED_SGSL_DATASET"}
    ):
        return False
    if not _integer(checkpoint["test_signer_count"], 1, 100_000):
        return False
    if not _number(checkpoint["minimum_confidence"], 0.0, 1.0):
        return False
    if not _valid_state_dict(checkpoint["state_dict"], torch):
        return False
    if not _valid_history(checkpoint["history"]):
        return False
    if not _integer(checkpoint["selected_epoch"], 1, len(checkpoint["history"])):
        return False
    if checkpoint["selected_epoch"] != _best_validation_epoch(checkpoint["history"]):
        return False
    if checkpoint["evaluation_split"] not in {"validation", "test"}:
        return False
    if not _valid_evaluation(checkpoint, torch):
        return False
    if not _valid_config(checkpoint):
        return False
    if schema_version == 1:
        return True
    return _valid_reproducibility(checkpoint) and _valid_threshold_selection(
        checkpoint
    )


def _valid_state_dict(state_dict, torch) -> bool:
    if not isinstance(state_dict, dict) or not 1 <= len(state_dict) <= 512:
        return False
    element_count = 0
    for name, value in state_dict.items():
        if type(name) is not str or not name or len(name) > 256:
            return False
        if not isinstance(value, torch.Tensor) or not value.dtype.is_floating_point:
            return False
        if value.device.type != "cpu" or value.layout != torch.strided or value.numel() < 1:
            return False
        element_count += value.numel()
        if element_count > 100_000_000 or not bool(torch.isfinite(value).all()):
            return False
    return True


def _valid_history(history) -> bool:
    if type(history) is not list or not 1 <= len(history) <= 100_000:
        return False
    expected = {
        "epoch",
        "trainingLoss",
        "validationMacroF1",
        "validationFalseFinalRate",
    }
    for index, entry in enumerate(history, start=1):
        if type(entry) is not dict or set(entry) != expected:
            return False
        if not _integer(entry["epoch"], index, index):
            return False
        if not _number(entry["trainingLoss"], 0.0, float("inf")):
            return False
        if not _number(entry["validationMacroF1"], 0.0, 1.0):
            return False
        if not _number(entry["validationFalseFinalRate"], 0.0, 1.0):
            return False
    return True


def _valid_evaluation(checkpoint, torch) -> bool:
    evaluation = checkpoint["evaluation"]
    expected = {"macro_f1", "accuracy", "false_final_rate", "sample_count"}
    if (
        type(evaluation) is dict
        and set(evaluation) == expected
        and _number(evaluation["macro_f1"], 0.0, 1.0)
        and _number(evaluation["accuracy"], 0.0, 1.0)
        and _number(evaluation["false_final_rate"], 0.0, 1.0)
        and _integer(evaluation["sample_count"], 1, 10_000_000)
    ):
        return True
    if type(evaluation) is not dict or set(evaluation) != {
        "schemaVersion",
        "datasetId",
        "manifestSha256",
        "provenanceStatus",
        "split",
        "metrics",
        "modelStateSha256",
    }:
        return False
    state_digest = evaluation["modelStateSha256"]
    if (
        type(state_digest) is not str
        or _SHA256.fullmatch(state_digest) is None
        or state_digest != _state_dict_sha256(checkpoint["state_dict"], torch)
    ):
        return False
    evaluation_without_state_digest = dict(evaluation)
    del evaluation_without_state_digest["modelStateSha256"]
    return _valid_rich_evaluation(evaluation_without_state_digest, checkpoint)


def _bind_evaluation_to_state(evaluation: dict, state_dict, torch) -> dict:
    bound = dict(evaluation)
    bound["modelStateSha256"] = _state_dict_sha256(state_dict, torch)
    return bound


def _state_dict_sha256(state_dict, torch) -> str:
    """Hash tensor names, dtypes, shapes, and exact bytes in canonical order."""
    digest = hashlib.sha256(b"signconnect-model-state-v1\0")
    for name in sorted(state_dict):
        tensor = state_dict[name].detach().cpu().contiguous()
        _update_length_prefixed(digest, name.encode("utf-8"))
        _update_length_prefixed(digest, str(tensor.dtype).encode("ascii"))
        digest.update(struct.pack(">Q", tensor.ndim))
        for dimension in tensor.shape:
            digest.update(struct.pack(">Q", dimension))
        raw_bytes = tensor.reshape(-1).view(torch.uint8).numpy().tobytes(order="C")
        _update_length_prefixed(digest, raw_bytes)
    return digest.hexdigest()


def _update_length_prefixed(digest, value: bytes) -> None:
    digest.update(struct.pack(">Q", len(value)))
    digest.update(value)


def _valid_rich_evaluation(evaluation, checkpoint) -> bool:
    if type(evaluation) is not dict or set(evaluation) != {
        "schemaVersion",
        "datasetId",
        "manifestSha256",
        "provenanceStatus",
        "split",
        "metrics",
    }:
        return False
    if (
        not _integer(evaluation["schemaVersion"], 1, 1)
        or evaluation["datasetId"] != checkpoint["dataset_id"]
        or evaluation["manifestSha256"] != checkpoint["manifest_sha256"]
        or evaluation["provenanceStatus"] != checkpoint["provenance_status"]
        or evaluation["split"] != checkpoint["evaluation_split"]
    ):
        return False
    metrics = evaluation["metrics"]
    required_metric_keys = {
        "macroF1",
        "accuracy",
        "falseFinalRate",
        "sampleCount",
        "perClass",
        "confusionMatrix",
        "noSignBehavior",
        "rejectionBehavior",
    }
    metric_keys = frozenset(metrics) if type(metrics) is dict else frozenset()
    if metric_keys not in {
        frozenset(required_metric_keys),
        frozenset(required_metric_keys | {"robustnessSlices"}),
    }:
        return False
    robustness_slices = metrics.get("robustnessSlices")
    if robustness_slices is not None and not _valid_robustness_slices(
        robustness_slices,
        metrics["sampleCount"],
        evaluation["provenanceStatus"],
    ):
        return False
    if (
        checkpoint["evaluation_split"] == "test"
        and checkpoint["provenance_status"] != "NON_PRODUCTION_SYNTHETIC"
        and robustness_slices is None
    ):
        return False
    if not all(
        _number(metrics[key], 0.0, 1.0)
        for key in ("macroF1", "accuracy", "falseFinalRate")
    ) or not _integer(metrics["sampleCount"], 1, 10_000_000):
        return False
    classes = checkpoint["classes"]
    per_class = metrics["perClass"]
    if type(per_class) is not list or len(per_class) != len(classes):
        return False
    supports = []
    for index, (entry, label_id) in enumerate(zip(per_class, classes)):
        if type(entry) is not dict or set(entry) != {
            "index", "labelId", "precision", "recall", "f1", "support"
        }:
            return False
        if entry["index"] != index or entry["labelId"] != label_id:
            return False
        if not all(_number(entry[key], 0.0, 1.0) for key in ("precision", "recall", "f1")):
            return False
        if not _integer(entry["support"], 0, 10_000_000):
            return False
        supports.append(entry["support"])
    if sum(supports) != metrics["sampleCount"]:
        return False

    confusion = metrics["confusionMatrix"]
    if (
        type(confusion) is not dict
        or set(confusion) != {"labelOrder", "rows"}
        or confusion["labelOrder"] != classes
        or type(confusion["rows"]) is not list
        or len(confusion["rows"]) != len(classes)
    ):
        return False
    matrix_total = 0
    for row, support in zip(confusion["rows"], supports):
        if (
            type(row) is not list
            or len(row) != len(classes)
            or any(not _integer(value, 0, 10_000_000) for value in row)
            or sum(row) != support
        ):
            return False
        matrix_total += sum(row)
    if matrix_total != metrics["sampleCount"]:
        return False
    diagonal = 0
    derived_f1 = []
    for index, row in enumerate(confusion["rows"]):
        true_positive = row[index]
        support = sum(row)
        predicted = sum(candidate[index] for candidate in confusion["rows"])
        precision = 0.0 if predicted == 0 else true_positive / predicted
        recall = 0.0 if support == 0 else true_positive / support
        f1_denominator = 2 * true_positive + (predicted - true_positive) + (
            support - true_positive
        )
        f1 = 0.0 if f1_denominator == 0 else 2 * true_positive / f1_denominator
        entry = per_class[index]
        if (
            entry["support"] != support
            or not _same_rate(entry["precision"], precision)
            or not _same_rate(entry["recall"], recall)
            or not _same_rate(entry["f1"], f1)
        ):
            return False
        diagonal += true_positive
        derived_f1.append(f1)
    if (
        not _same_rate(metrics["accuracy"], diagonal / matrix_total)
        or not _same_rate(metrics["macroF1"], sum(derived_f1) / len(derived_f1))
    ):
        return False

    no_sign = metrics["noSignBehavior"]
    if type(no_sign) is not dict or set(no_sign) != {
        "sampleCount", "falseFinalCount", "falseFinalRate"
    }:
        return False
    if (
        not _integer(no_sign["sampleCount"], 0, metrics["sampleCount"])
        or no_sign["sampleCount"] != supports[0]
        or not _integer(no_sign["falseFinalCount"], 0, no_sign["sampleCount"])
        or not _number(no_sign["falseFinalRate"], 0.0, 1.0)
    ):
        return False
    expected_false_final_rate = (
        0.0
        if no_sign["sampleCount"] == 0
        else no_sign["falseFinalCount"] / no_sign["sampleCount"]
    )
    if not _same_rate(no_sign["falseFinalRate"], expected_false_final_rate):
        return False
    if not _same_rate(metrics["falseFinalRate"], no_sign["falseFinalRate"]):
        return False
    reject_support = sum(
        support
        for label_id, support in zip(classes, supports)
        if label_id == OUT_OF_VOCABULARY
    )
    return _valid_rejection_behavior(
        metrics["rejectionBehavior"],
        metrics["sampleCount"],
        checkpoint["minimum_confidence"],
        reject_support,
    )


def _valid_robustness_slices(slices, sample_count: int, provenance_status: str) -> bool:
    if type(slices) is not dict or set(slices) != set(_ROBUSTNESS_SLICE_VALUES):
        return False
    expected_entry_keys = {
        "value",
        "support",
        "accuracy",
        "macroF1",
        "falseFinalRate",
        "rejectionRate",
    }
    for dimension, allowed_values in _ROBUSTNESS_SLICE_VALUES.items():
        entries = slices[dimension]
        if type(entries) is not list or not entries:
            return False
        observed_values = []
        support_total = 0
        for entry in entries:
            if type(entry) is not dict or set(entry) != expected_entry_keys:
                return False
            value = entry["value"]
            if value not in allowed_values or value in observed_values:
                return False
            if (
                provenance_status != "NON_PRODUCTION_SYNTHETIC"
                and dimension == "handedness"
                and value == "UNKNOWN"
            ):
                return False
            if not _integer(entry["support"], 1, sample_count):
                return False
            if not all(
                _number(entry[key], 0.0, 1.0)
                for key in (
                    "accuracy",
                    "macroF1",
                    "falseFinalRate",
                    "rejectionRate",
                )
            ):
                return False
            observed_values.append(value)
            support_total += entry["support"]
        if observed_values != [value for value in allowed_values if value in observed_values]:
            return False
        if support_total != sample_count:
            return False
    return True


def _valid_rejection_behavior(
    behavior,
    sample_count: int,
    minimum_confidence: float,
    reject_support: int,
) -> bool:
    expected = {
        "minimumConfidence",
        "acceptedSignCount",
        "lowConfidenceRejectionCount",
        "noSignDecisionCount",
        "rejectionRate",
        "acceptedSignAccuracy",
        "unknownSampleCount",
        "unknownRejectedCount",
        "unknownRejectionRate",
        "unknownFalseFinalCount",
        "unknownFalseFinalRate",
    }
    if type(behavior) is not dict or set(behavior) != expected:
        return False
    if (
        not _number(behavior["minimumConfidence"], minimum_confidence, minimum_confidence)
        or any(
            not _integer(behavior[key], 0, sample_count)
            for key in (
                "acceptedSignCount",
                "lowConfidenceRejectionCount",
                "noSignDecisionCount",
                "unknownSampleCount",
                "unknownRejectedCount",
                "unknownFalseFinalCount",
            )
        )
        or not _number(behavior["rejectionRate"], 0.0, 1.0)
    ):
        return False
    if (
        behavior["acceptedSignCount"]
        + behavior["lowConfidenceRejectionCount"]
        + behavior["noSignDecisionCount"]
        != sample_count
    ):
        return False
    if not _same_rate(
        behavior["rejectionRate"],
        behavior["lowConfidenceRejectionCount"] / sample_count,
    ):
        return False
    accepted_accuracy = behavior["acceptedSignAccuracy"]
    if (accepted_accuracy is None) != (behavior["acceptedSignCount"] == 0):
        return False
    if accepted_accuracy is not None and not _number(accepted_accuracy, 0.0, 1.0):
        return False
    unknown_count = behavior["unknownSampleCount"]
    if unknown_count != reject_support:
        return False
    if behavior["unknownRejectedCount"] + behavior["unknownFalseFinalCount"] != unknown_count:
        return False
    for count_key, rate_key in (
        ("unknownRejectedCount", "unknownRejectionRate"),
        ("unknownFalseFinalCount", "unknownFalseFinalRate"),
    ):
        rate = behavior[rate_key]
        if (rate is None) != (unknown_count == 0):
            return False
        if rate is not None and (
            not _number(rate, 0.0, 1.0)
            or not _same_rate(rate, behavior[count_key] / unknown_count)
        ):
            return False
    return True


def _same_rate(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= 1e-12


def _best_validation_epoch(history) -> int:
    return max(
        history,
        key=lambda entry: (
            entry["validationMacroF1"],
            -entry["validationFalseFinalRate"],
            -entry["epoch"],
        ),
    )["epoch"]


def _valid_config(checkpoint) -> bool:
    config = checkpoint["config"]
    expected_keys = (
        _CONFIG_KEYS_V1 if checkpoint["schema_version"] == 1 else _CONFIG_KEYS_V2
    )
    if type(config) is not dict or set(config) != expected_keys:
        return False
    if type(config["model"]) is not str:
        return False
    common_valid = (
        config["model"] == checkpoint["architecture"]
        and _integer(config["seed"], checkpoint["seed"], checkpoint["seed"])
        and _integer(
            config["hidden_size"],
            checkpoint["hidden_size"],
            checkpoint["hidden_size"],
        )
        and _number(config["dropout"], checkpoint["dropout"], checkpoint["dropout"])
        and _number(config["false_final_threshold"], 0.0, 1.0)
        and _integer(
            config["epochs"], len(checkpoint["history"]), len(checkpoint["history"])
        )
        and _integer(config["batch_size"], 1, 10_000_000)
        and _number(config["learning_rate"], 0.0, 1.0, minimum_inclusive=False)
    )
    if checkpoint["schema_version"] == 1:
        return common_valid and _number(
            config["false_final_threshold"],
            checkpoint["minimum_confidence"],
            checkpoint["minimum_confidence"],
        )
    candidates = config["threshold_candidates"]
    return (
        common_valid
        and config["input_contract_version"] == FEATURE_CONTRACT
        and config["augmentation_policy"] == "none"
        and config["optimizer_name"] == "adam"
        and config["learning_rate_schedule"] == "constant"
        and type(candidates) is list
        and bool(candidates)
        and all(_number(value, 0.0, 1.0) for value in candidates)
        and sorted(set(candidates)) == candidates
        and config["false_final_threshold"] in candidates
    )


def _valid_reproducibility(checkpoint) -> bool:
    evidence = checkpoint["reproducibility"]
    if type(evidence) is not dict or set(evidence) != {
        "schemaVersion",
        "configSha256",
        "dependencyLock",
        "sourceControl",
    }:
        return False
    encoded_config = json.dumps(
        checkpoint["config"], sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if (
        not _integer(evidence["schemaVersion"], 1, 1)
        or type(evidence["configSha256"]) is not str
        or evidence["configSha256"] != hashlib.sha256(encoded_config).hexdigest()
    ):
        return False
    dependency_lock = evidence["dependencyLock"]
    if (
        type(dependency_lock) is not dict
        or set(dependency_lock) != {"file", "sha256"}
        or dependency_lock["file"] != "uv.lock"
        or type(dependency_lock["sha256"]) is not str
        or _SHA256.fullmatch(dependency_lock["sha256"]) is None
    ):
        return False
    source_control = evidence["sourceControl"]
    if type(source_control) is not dict or set(source_control) != {
        "commit",
        "dirty",
        "trackedChangesSha256",
        "untrackedFileCount",
        "untrackedStateSha256",
        "untrackedContentSha256",
    }:
        return False
    commit = source_control["commit"]
    dirty = source_control["dirty"]
    if commit is None:
        return all(value is None for value in source_control.values())
    tracked_changes_sha256 = source_control["trackedChangesSha256"]
    untracked_file_count = source_control["untrackedFileCount"]
    untracked_state_sha256 = source_control["untrackedStateSha256"]
    untracked_content_sha256 = source_control["untrackedContentSha256"]
    has_tracked_changes = tracked_changes_sha256 != _EMPTY_SHA256
    has_untracked_changes = untracked_file_count > 0
    return (
        type(commit) is str
        and re.fullmatch(r"[a-f0-9]{40,64}", commit) is not None
        and type(dirty) is bool
        and type(tracked_changes_sha256) is str
        and _SHA256.fullmatch(tracked_changes_sha256) is not None
        and type(untracked_file_count) is int
        and untracked_file_count >= 0
        and type(untracked_state_sha256) is str
        and _SHA256.fullmatch(untracked_state_sha256) is not None
        and type(untracked_content_sha256) is str
        and _SHA256.fullmatch(untracked_content_sha256) is not None
        and dirty == (has_tracked_changes or has_untracked_changes)
        and (
            untracked_file_count > 0
            or (
                untracked_state_sha256 == _EMPTY_SHA256
                and untracked_content_sha256 == _EMPTY_SHA256
            )
        )
    )


def _valid_threshold_selection(checkpoint) -> bool:
    selection = checkpoint["threshold_selection"]
    if type(selection) is not dict or set(selection) != {
        "split",
        "objective",
        "candidates",
        "tieBreak",
        "selectedThreshold",
        "results",
    }:
        return False
    candidates = selection["candidates"]
    results = selection["results"]
    if (
        selection["split"] != "validation"
        or selection["objective"]
        != "minimize_false_final_rate_then_rejection_rate"
        or selection["tieBreak"] != "lowest_threshold"
        or candidates != checkpoint["config"]["threshold_candidates"]
        or type(results) is not list
        or len(results) != len(candidates)
    ):
        return False
    for threshold, result in zip(candidates, results):
        if (
            type(result) is not dict
            or set(result) != {"threshold", "falseFinalRate", "rejectionRate"}
            or not _number(result["threshold"], threshold, threshold)
            or not _number(result["falseFinalRate"], 0.0, 1.0)
            or not _number(result["rejectionRate"], 0.0, 1.0)
        ):
            return False
    selected = min(
        results,
        key=lambda result: (
            result["falseFinalRate"],
            result["rejectionRate"],
            result["threshold"],
        ),
    )["threshold"]
    return (
        _number(selection["selectedThreshold"], selected, selected)
        and _number(checkpoint["minimum_confidence"], selected, selected)
    )


def _integer(value, minimum: int, maximum: int) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _number(
    value,
    minimum: float,
    maximum: float,
    *,
    minimum_inclusive: bool = True,
    maximum_inclusive: bool = True,
) -> bool:
    if type(value) is not float or not math.isfinite(value):
        return False
    lower = value >= minimum if minimum_inclusive else value > minimum
    upper = value <= maximum if maximum_inclusive else value < maximum
    return lower and upper


def evaluate_checkpoint(
    checkpoint_path: str | Path,
    manifest_path: str | Path,
    split_path: str | Path,
    output_path: str | Path,
    split_name: str = "test",
    batch_size: int = 32,
    false_final_threshold: float = 0.8,
) -> Path:
    import torch

    from .splits import load_split, split_sha256

    if split_name not in {"train", "validation", "test"}:
        raise ValueError("split_name must be train, validation, or test")
    manifest = load_manifest(manifest_path)
    model, checkpoint = load_checkpoint_model(
        checkpoint_path,
        allow_pending_final_test=True,
    )
    if checkpoint["manifest_sha256"] != manifest.sha256:
        raise ValueError("checkpoint and evaluation manifest hashes differ")
    assignment = load_split(split_path, manifest)
    if checkpoint["split_sha256"] != split_sha256(assignment):
        raise ValueError("evaluation split differs from the locked checkpoint split")
    if split_name == "test" and checkpoint["evaluation_split"] == "test":
        raise ValueError("locked final test has already been evaluated for this checkpoint")
    if (
        split_name == "test"
        and false_final_threshold != checkpoint["minimum_confidence"]
    ):
        raise ValueError("final test must use the locked confidence threshold")
    metrics = evaluate_model(
        model,
        LandmarkDataset(manifest, assignment.sample_ids(split_name)),
        manifest,
        batch_size,
        false_final_threshold,
    )
    target = Path(output_path)
    evaluation = _bind_evaluation_to_state(
        metrics_document(metrics, manifest, split_name),
        checkpoint["state_dict"],
        torch,
    )
    write_evaluation(target, evaluation)
    if split_name == "test":
        checkpoint["evaluation_split"] = "test"
        checkpoint["evaluation"] = evaluation
        torch.save(checkpoint, Path(checkpoint_path))
    return target
