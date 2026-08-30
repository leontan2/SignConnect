from __future__ import annotations

import math
import re
from pathlib import Path

from .config import TrainConfig
from .dataset import LandmarkDataset
from .evaluation import evaluate_model, metrics_document, write_evaluation
from .manifest import load_manifest, require_training_authorization
from .models import build_model
from .reproducibility import set_global_determinism
from .splits import create_signer_grouped_split, split_sha256, write_split


_CHECKPOINT_ERROR = "checkpoint does not satisfy the SignConnect model contract"
_CHECKPOINT_KEYS = {
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
    "evaluation",
    "split_sha256",
    "test_signer_count",
    "minimum_confidence",
    "config",
}
_CONFIG_KEYS = {
    "seed",
    "model",
    "epochs",
    "batch_size",
    "learning_rate",
    "hidden_size",
    "dropout",
    "false_final_threshold",
}
_LABEL = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_DATASET_ID = re.compile(r"^[a-z][a-z0-9-]{2,63}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def train(config: TrainConfig) -> Path:
    import torch

    set_global_determinism(config.seed)
    manifest = load_manifest(config.manifest)
    require_training_authorization(manifest)
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

    test_metrics = evaluate_model(
        model,
        LandmarkDataset(manifest, split.test),
        manifest,
        config.batch_size,
        config.false_final_threshold,
    )
    evaluation = metrics_document(test_metrics, manifest, "test")
    write_evaluation(config.output_dir / "evaluation.json", evaluation)
    checkpoint_path = config.output_dir / "checkpoint.pt"
    torch.save(
        {
            "schema_version": 1,
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
            "evaluation": {
                "macro_f1": test_metrics.macro_f1,
                "accuracy": test_metrics.accuracy,
                "false_final_rate": test_metrics.false_final_rate,
                "sample_count": len(split.test),
            },
            "split_sha256": split_sha256(split),
            "test_signer_count": manifest.test_signer_count,
            "minimum_confidence": config.false_final_threshold,
            "config": {
                "seed": config.seed,
                "model": config.model,
                "epochs": config.epochs,
                "batch_size": config.batch_size,
                "learning_rate": config.learning_rate,
                "hidden_size": config.hidden_size,
                "dropout": config.dropout,
                "false_final_threshold": config.false_final_threshold,
            },
        },
        checkpoint_path,
    )
    return checkpoint_path


def load_checkpoint_model(checkpoint_path: str | Path):
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
    if type(checkpoint) is not dict or set(checkpoint) != _CHECKPOINT_KEYS:
        return False
    if not _integer(checkpoint["schema_version"], 1, 1):
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
    if not _valid_evaluation(checkpoint["evaluation"]):
        return False
    return _valid_config(checkpoint)


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


def _valid_evaluation(evaluation) -> bool:
    expected = {"macro_f1", "accuracy", "false_final_rate", "sample_count"}
    return (
        type(evaluation) is dict
        and set(evaluation) == expected
        and _number(evaluation["macro_f1"], 0.0, 1.0)
        and _number(evaluation["accuracy"], 0.0, 1.0)
        and _number(evaluation["false_final_rate"], 0.0, 1.0)
        and _integer(evaluation["sample_count"], 1, 10_000_000)
    )


def _valid_config(checkpoint) -> bool:
    config = checkpoint["config"]
    if type(config) is not dict or set(config) != _CONFIG_KEYS:
        return False
    if type(config["model"]) is not str:
        return False
    return (
        config["model"] == checkpoint["architecture"]
        and _integer(config["seed"], checkpoint["seed"], checkpoint["seed"])
        and _integer(
            config["hidden_size"],
            checkpoint["hidden_size"],
            checkpoint["hidden_size"],
        )
        and _number(config["dropout"], checkpoint["dropout"], checkpoint["dropout"])
        and _number(
            config["false_final_threshold"],
            checkpoint["minimum_confidence"],
            checkpoint["minimum_confidence"],
        )
        and _integer(config["epochs"], len(checkpoint["history"]), len(checkpoint["history"]))
        and _integer(config["batch_size"], 1, 10_000_000)
        and _number(config["learning_rate"], 0.0, 1.0, minimum_inclusive=False)
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
    from .splits import load_split

    manifest = load_manifest(manifest_path)
    model, checkpoint = load_checkpoint_model(checkpoint_path)
    if checkpoint["manifest_sha256"] != manifest.sha256:
        raise ValueError("checkpoint and evaluation manifest hashes differ")
    if split_name not in {"train", "validation", "test"}:
        raise ValueError("split_name must be train, validation, or test")
    assignment = load_split(split_path, manifest)
    metrics = evaluate_model(
        model,
        LandmarkDataset(manifest, assignment.sample_ids(split_name)),
        manifest,
        batch_size,
        false_final_threshold,
    )
    target = Path(output_path)
    write_evaluation(target, metrics_document(metrics, manifest, split_name))
    return target
