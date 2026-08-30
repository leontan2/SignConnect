from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

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
    )
    if config.epochs < 1 or config.batch_size < 1 or config.hidden_size < 1:
        raise ValueError("epochs, batch_size, and hidden_size must be positive")
    if not 0 <= config.dropout < 1 or config.learning_rate <= 0:
        raise ValueError("dropout or learning rate is invalid")
    return config


def _resolve(config_path: Path, value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate
    return (config_path.parent.parent / candidate).resolve()
