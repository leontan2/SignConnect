from __future__ import annotations

import torch

from signconnect_ml.openhands_asl import (
    CALIBRATED_UNKNOWN_MARGIN,
    FEATURE_LAYOUT_VERSION,
    RUNTIME_LABELS,
    OpenHandsAslResearchAdapter,
    adapt_signconnect_features,
)


class FixedNetwork(torch.nn.Module):
    def __init__(self, logits: list[float]):
        super().__init__()
        self.register_buffer("logits", torch.tensor(logits, dtype=torch.float32))
        self.last_shape: tuple[int, ...] | None = None

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        self.last_shape = tuple(features.shape)
        return self.logits.unsqueeze(0).expand(features.shape[0], -1)


def active_features() -> torch.Tensor:
    features = torch.zeros((1, 30, 224), dtype=torch.float32)
    reshaped = features.view(1, 30, 56, 4)
    reshaped[:, :, :21, 3] = 1
    reshaped[:, :, 42:, 3] = 1
    for slot in range(56):
        reshaped[:, :, slot, 0] = slot / 100
        reshaped[:, :, slot, 1] = -slot / 100
    return features


def test_runtime_vocabulary_is_bounded_and_user_facing() -> None:
    assert FEATURE_LAYOUT_VERSION == "mediapipe-holistic-224-v2"
    assert [label.id for label in RUNTIME_LABELS] == [
        "NO_SIGN",
        "HELLO",
        "THANK_YOU",
        "YES",
        "NO",
        "HELP",
        "REPEAT",
        "SLOWER",
        "UNDERSTAND",
        "FINISHED",
        "GOODBYE",
    ]
    assert [label.caption_text for label in RUNTIME_LABELS[1:]] == [
        "Hello",
        "Thank you",
        "Yes",
        "No",
        "Help",
        "Repeat",
        "Slower",
        "Understand",
        "Finished",
        "Goodbye",
    ]


def test_adapter_maps_v2_landmarks_to_the_openhands_tensor() -> None:
    source = active_features()
    for frame_index in range(30):
        source[0, frame_index, 0] = frame_index
    adapted = adapt_signconnect_features(source)

    # The released SL-GCN checkpoint was trained and evaluated with exactly 64
    # uniformly sampled frames, even though SignConnect's transport stays at 30.
    assert adapted.shape == (1, 2, 64, 27)
    # Pose slots 0, 2, 5, 11, 12, 13, 14 are the first seven v2 pose slots.
    assert adapted[0, 0, 0, :7].tolist() == [
        source[0, 0, 168 + offset * 4].item() for offset in range(7)
    ]
    # OpenHands' ten selected left-hand points follow the seven pose points.
    assert adapted[0, 0, 0, 7:17].tolist() == [
        source[0, 0, index * 4].item()
        for index in (0, 4, 5, 8, 9, 12, 13, 16, 17, 20)
    ]
    assert adapted[0, 0, 0, 7].item() == 0
    assert adapted[0, 0, -1, 7].item() == 29


def test_supported_alias_beats_a_close_unknown_and_emits_a_caption_class() -> None:
    # Vocabulary positions: hello=0, salute=1, unrelated=2, then the remaining concepts.
    network = FixedNetwork([1.0, 2.0, 2.1, -2, -2, -2, -2, -2, -2, -2, -2])
    model = OpenHandsAslResearchAdapter(
        network,
        concept_indices=((0, 1), (3,), (4,), (5,), (6,), (7,), (8,), (9,), (10,), (3,)),
        vocabulary_size=11,
    )

    probabilities = model(active_features())

    assert network.last_shape == (1, 2, 64, 27)
    assert probabilities.shape == (1, 11)
    assert torch.allclose(probabilities.sum(dim=1), torch.ones(1), atol=1e-6)
    assert int(probabilities.argmax(dim=1).item()) == 1
    assert float(probabilities[0, 1]) >= 0.80


def test_calibrated_margin_accepts_the_observed_official_hello_domain_shift() -> None:
    # The browser Tasks extractor places the official Hello example 12 logits
    # below an unrelated open-set class while Hello remains the clear winner
    # within SignConnect's bounded supported vocabulary.
    network = FixedNetwork([0.2, -20.0, 12.0, -20, -20, -20, -20, -20, -20, -20, -20])
    model = OpenHandsAslResearchAdapter(
        network,
        concept_indices=((0, 1), (3,), (4,), (5,), (6,), (7,), (8,), (9,), (10,), (3,)),
        vocabulary_size=11,
        unknown_margin=CALIBRATED_UNKNOWN_MARGIN,
    )

    probabilities = model(active_features())

    assert int(probabilities.argmax(dim=1).item()) == 1
    assert float(probabilities[0, 1]) >= 0.80


def test_unsupported_gesture_and_missing_hands_fail_closed_to_no_sign() -> None:
    unsupported = FixedNetwork([0.0, 0.0, 7.0, -2, -2, -2, -2, -2, -2, -2, -2])
    model = OpenHandsAslResearchAdapter(
        unsupported,
        concept_indices=((0, 1), (3,), (4,), (5,), (6,), (7,), (8,), (9,), (10,), (3,)),
        vocabulary_size=11,
        unknown_margin=0.25,
    )

    unsupported_probabilities = model(active_features())
    idle_probabilities = model(torch.zeros((1, 30, 224), dtype=torch.float32))

    assert int(unsupported_probabilities.argmax(dim=1).item()) == 0
    assert int(idle_probabilities.argmax(dim=1).item()) == 0
    assert float(idle_probabilities[0, 0]) > 0.99
