from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .constants import FEATURE_CONTRACT

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


@dataclass(frozen=True)
class TrainConfig:
    seed: int
    model: str
    manifest: Path
    output_dir: Path
    epochs: int
    batch_size: int
    learning_rate: float
    hidden_size: int
    dropout: float
    false_final_threshold: float
    input_contract_version: str = FEATURE_CONTRACT
    augmentation_policy: str = "none"
    optimizer_name: str = "adam"
    learning_rate_schedule: str = "constant"
    threshold_candidates: tuple[float, ...] = ()


def load_config(path: str | Path) -> TrainConfig:
    config_path = Path(path).resolve()
    with config_path.open("rb") as handle:
        raw = tomllib.load(handle)
    model = str(raw["model"])
    if model not in {"tcn", "gru"}:
        raise ValueError("model must be tcn or gru")
    config = TrainConfig(
        seed=int(raw["seed"]),
        model=model,
        manifest=_resolve(config_path, raw["manifest"]),
        output_dir=_resolve(config_path, raw["output_dir"]),
        epochs=int(raw["epochs"]),
        batch_size=int(raw["batch_size"]),
        learning_rate=float(raw["learning_rate"]),
        hidden_size=int(raw["hidden_size"]),
        dropout=float(raw["dropout"]),
        false_final_threshold=float(raw["false_final_threshold"]),
        input_contract_version=str(
            raw.get("input_contract_version", FEATURE_CONTRACT)
        ),
        augmentation_policy=str(raw.get("augmentation_policy", "none")),
        optimizer_name=str(raw.get("optimizer_name", "adam")),
        learning_rate_schedule=str(
            raw.get("learning_rate_schedule", "constant")
        ),
        threshold_candidates=tuple(
            float(value) for value in raw.get("threshold_candidates", ())
        ),
    )
    if config.epochs < 1 or config.batch_size < 1 or config.hidden_size < 1:
        raise ValueError("epochs, batch_size, and hidden_size must be positive")
    if not 0 <= config.dropout < 1 or config.learning_rate <= 0:
        raise ValueError("dropout or learning rate is invalid")
    if config.input_contract_version != FEATURE_CONTRACT:
        raise ValueError(f"input_contract_version must be {FEATURE_CONTRACT}")
    if config.augmentation_policy != "none":
        raise ValueError("augmentation_policy must be none")
    if config.optimizer_name != "adam":
        raise ValueError("optimizer_name must be adam")
    if config.learning_rate_schedule != "constant":
        raise ValueError("learning_rate_schedule must be constant")
    if config.threshold_candidates and (
        any(not 0.0 <= value <= 1.0 for value in config.threshold_candidates)
        or tuple(sorted(set(config.threshold_candidates)))
        != config.threshold_candidates
        or config.false_final_threshold not in config.threshold_candidates
    ):
        raise ValueError(
            "threshold_candidates must be unique ascending values in [0,1] "
            "and include false_final_threshold"
        )
    return config


def training_config_document(config: TrainConfig) -> dict:
    """Return the canonical, path-free training configuration."""
    candidates = config.threshold_candidates or (config.false_final_threshold,)
    return {
        "seed": config.seed,
        "model": config.model,
        "epochs": config.epochs,
        "batch_size": config.batch_size,
        "learning_rate": config.learning_rate,
        "hidden_size": config.hidden_size,
        "dropout": config.dropout,
        "false_final_threshold": config.false_final_threshold,
        "input_contract_version": config.input_contract_version,
        "augmentation_policy": config.augmentation_policy,
        "optimizer_name": config.optimizer_name,
        "learning_rate_schedule": config.learning_rate_schedule,
        "threshold_candidates": list(candidates),
    }


def config_sha256(config: TrainConfig) -> str:
    encoded = json.dumps(
        training_config_document(config),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _resolve(config_path: Path, value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate
    return (config_path.parent.parent / candidate).resolve()
