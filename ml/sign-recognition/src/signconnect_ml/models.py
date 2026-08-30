from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import torch


def build_model(
    architecture: str,
    class_count: int,
    hidden_size: int = 64,
    dropout: float = 0.1,
) -> "torch.nn.Module":
    import torch.nn as nn

    if architecture == "tcn":
        return TemporalConvClassifier(class_count, hidden_size, dropout)
    if architecture == "gru":
        return GruClassifier(class_count, hidden_size, dropout)
    raise ValueError(f"unsupported architecture: {architecture}")


def _torch_modules():
    import torch
    import torch.nn as nn

    return torch, nn


class TemporalConvClassifierBase:
    pass


def _make_temporal_conv_class():
    _, nn = _torch_modules()

    class ResidualTemporalBlock(nn.Module):
        def __init__(self, channels: int, dilation: int, dropout: float) -> None:
            super().__init__()
            self.network = nn.Sequential(
                nn.Conv1d(
                    channels,
                    channels,
                    kernel_size=3,
                    padding=dilation,
                    dilation=dilation,
                ),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Conv1d(channels, channels, kernel_size=1),
            )
            self.activation = nn.GELU()

        def forward(self, features):
            return self.activation(features + self.network(features))

    class TemporalConvClassifier(nn.Module):
        def __init__(self, class_count: int, hidden_size: int = 64, dropout: float = 0.1) -> None:
            super().__init__()
            from .constants import FEATURE_COUNT

            self.projection = nn.Conv1d(FEATURE_COUNT, hidden_size, kernel_size=1)
            self.temporal = nn.Sequential(
                ResidualTemporalBlock(hidden_size, 1, dropout),
                ResidualTemporalBlock(hidden_size, 2, dropout),
                ResidualTemporalBlock(hidden_size, 4, dropout),
            )
            self.pool = nn.AdaptiveAvgPool1d(1)
            self.classifier = nn.Linear(hidden_size, class_count)

        def forward(self, features):
            hidden = self.projection(features.transpose(1, 2))
            hidden = self.temporal(hidden)
            return self.classifier(self.pool(hidden).squeeze(-1))

    return TemporalConvClassifier


def _make_gru_class():
    _, nn = _torch_modules()

    class GruClassifier(nn.Module):
        def __init__(self, class_count: int, hidden_size: int = 64, dropout: float = 0.1) -> None:
            super().__init__()
            from .constants import FEATURE_COUNT

            self.gru = nn.GRU(
                input_size=FEATURE_COUNT,
                hidden_size=hidden_size,
                num_layers=1,
                batch_first=True,
            )
            self.dropout = nn.Dropout(dropout)
            self.classifier = nn.Linear(hidden_size, class_count)

        def forward(self, features):
            _, final_hidden = self.gru(features)
            return self.classifier(self.dropout(final_hidden[-1]))

    return GruClassifier


try:
    TemporalConvClassifier = _make_temporal_conv_class()
    GruClassifier = _make_gru_class()
except ModuleNotFoundError as exc:
    if exc.name != "torch":
        raise

    class _TorchRequired:
        def __init__(self, *args, **kwargs) -> None:
            raise ModuleNotFoundError("PyTorch is required for model operations")

    TemporalConvClassifier = _TorchRequired
    GruClassifier = _TorchRequired
