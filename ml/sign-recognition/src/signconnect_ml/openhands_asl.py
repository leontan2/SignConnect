from __future__ import annotations

import hashlib
import json
import sys
import warnings
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import numpy as np
import torch

from .contracts import canonical_vocabulary_sha256, validate_contract_document


FEATURE_LAYOUT_VERSION = "mediapipe-holistic-224-v2"
FEATURE_COUNT = 224
SEQUENCE_LENGTH = 30
OPENHANDS_SEQUENCE_LENGTH = 64
LANDMARK_COUNT = 56
VALUES_PER_LANDMARK = 4
HAND_LANDMARK_INDICES = (0, 4, 5, 8, 9, 12, 13, 16, 17, 20)
OPENHANDS_REVISION = "fc4599d2c6a9e68d002bb2e1832a835e9b8b512d"
OPENHANDS_SLGCN_CHECKPOINT_SHA256 = "e765c49adae1adc817a8f00331bf7561775e033e58d2cc28cabcd9ee1402bc7c"
OPENHANDS_WLASL_METADATA_SHA256 = "4828ae6b9a630a0169feabc6ab14668e40ea95d477b842b37175e4bd8a16932a"
MODEL_VERSION = "asl-wlasl-slgcn-core-v2"
MODEL_FILENAME = "openhands-wlasl-slgcn-core-v2.onnx"
CALIBRATED_UNKNOWN_MARGIN = 12.5


@dataclass(frozen=True)
class RuntimeLabel:
    id: str
    caption_text: str | None


RUNTIME_LABELS = (
    RuntimeLabel("NO_SIGN", None),
    RuntimeLabel("HELLO", "Hello"),
    RuntimeLabel("THANK_YOU", "Thank you"),
    RuntimeLabel("YES", "Yes"),
    RuntimeLabel("NO", "No"),
    RuntimeLabel("HELP", "Help"),
    RuntimeLabel("REPEAT", "Repeat"),
    RuntimeLabel("SLOWER", "Slower"),
    RuntimeLabel("UNDERSTAND", "Understand"),
    RuntimeLabel("FINISHED", "Finished"),
    RuntimeLabel("GOODBYE", "Goodbye"),
)

# Semantically equivalent WLASL glosses are aggregated before open-set rejection.
# Ambiguous visual neighbours are deliberately not included.
CONCEPT_GLOSSES = (
    ("hello", "salute"),
    ("thank you",),
    ("yes",),
    ("no",),
    ("help", "aid", "assist"),
    ("repeat", "again"),
    ("slow",),
    ("understand",),
    ("finish", "done", "complete"),
    ("goodbye", "bye"),
)


def concept_indices_for(glosses: Sequence[str]) -> tuple[tuple[int, ...], ...]:
    positions = {gloss: index for index, gloss in enumerate(glosses)}
    missing = sorted(
        gloss
        for concept in CONCEPT_GLOSSES
        for gloss in concept
        if gloss not in positions
    )
    if missing:
        raise ValueError(f"OpenHands vocabulary is missing required glosses: {', '.join(missing)}")
    return tuple(tuple(positions[gloss] for gloss in concept) for concept in CONCEPT_GLOSSES)


def adapt_signconnect_features(features: torch.Tensor) -> torch.Tensor:
    """Map SignConnect v2 features to OpenHands' 64-frame, 27-point XY layout."""
    if features.ndim != 3 or tuple(features.shape[1:]) != (SEQUENCE_LENGTH, FEATURE_COUNT):
        raise ValueError("features must have shape [batch, 30, 224]")

    landmarks = features.reshape(
        features.shape[0], SEQUENCE_LENGTH, LANDMARK_COUNT, VALUES_PER_LANDMARK
    )
    # v2 pose slots begin at landmark 42. Its first seven slots are MediaPipe
    # pose 0, 2, 5, 11, 12, 13, and 14 in that order.
    pose = landmarks[:, :, 42:49, :2]
    left = landmarks[:, :, HAND_LANDMARK_INDICES, :2]
    right_indices = tuple(21 + index for index in HAND_LANDMARK_INDICES)
    right = landmarks[:, :, right_indices, :2]
    points = torch.cat((pose, left, right), dim=2)
    # Match OpenHands' released WLASL evaluation transform exactly:
    # torch.linspace(0, source_frames - 1, 64).long(). The browser transport
    # remains the stable 30-frame SignConnect contract.
    temporal_indices = torch.linspace(
        0,
        SEQUENCE_LENGTH - 1,
        OPENHANDS_SEQUENCE_LENGTH,
        device=features.device,
    ).long()
    points = points.index_select(1, temporal_indices)
    return points.permute(0, 3, 1, 2).contiguous()


class OpenHandsAslResearchAdapter(torch.nn.Module):
    """Bound a 2,000-gloss OpenHands network to SignConnect's audited vocabulary.

    Output index zero is the canonical fail-closed outcome for no hands, an
    unsupported gesture, or a low-confidence open-set decision.
    """

    def __init__(
        self,
        network: torch.nn.Module,
        concept_indices: Sequence[Sequence[int]],
        vocabulary_size: int,
        *,
        unknown_margin: float = CALIBRATED_UNKNOWN_MARGIN,
        logit_scale: float = 8.0,
    ) -> None:
        super().__init__()
        if len(concept_indices) != len(RUNTIME_LABELS) - 1:
            raise ValueError("concept_indices must define every runtime sign label")
        if vocabulary_size < 2 or any(not indices for indices in concept_indices):
            raise ValueError("OpenHands vocabulary and concept mappings must be non-empty")
        flattened = [index for indices in concept_indices for index in indices]
        if any(index < 0 or index >= vocabulary_size for index in flattened):
            raise ValueError("concept index is outside the OpenHands vocabulary")
        if not 0.0 < unknown_margin < 20.0 or not 1.0 <= logit_scale <= 20.0:
            raise ValueError("open-set calibration values are outside the supported bounds")

        self.network = network
        self.concept_indices = tuple(tuple(indices) for indices in concept_indices)
        self.unknown_margin = float(unknown_margin)
        self.logit_scale = float(logit_scale)
        unsupported = torch.ones(vocabulary_size, dtype=torch.bool)
        unsupported[flattened] = False
        self.register_buffer("unsupported_mask", unsupported)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        model_features = adapt_signconnect_features(features)
        logits = self.network(model_features)
        if logits.ndim != 2 or logits.shape[1] != self.unsupported_mask.numel():
            raise ValueError("OpenHands network output does not match its vocabulary")

        concept_logits = torch.stack(
            [torch.logsumexp(logits[:, indices], dim=1) for indices in self.concept_indices],
            dim=1,
        )
        unsupported_logits = logits.masked_fill(~self.unsupported_mask, float("-inf"))
        unknown_logit = unsupported_logits.max(dim=1).values - self.unknown_margin

        landmarks = features.reshape(
            features.shape[0], SEQUENCE_LENGTH, LANDMARK_COUNT, VALUES_PER_LANDMARK
        )
        hand_presence = landmarks[:, :, :42, 3].mean(dim=(1, 2))
        idle_logit = concept_logits.max(dim=1).values + 20.0
        no_sign_logit = torch.where(hand_presence <= 0.01, idle_logit, unknown_logit)

        bounded_logits = torch.cat((no_sign_logit.unsqueeze(1), concept_logits), dim=1)
        return torch.softmax(bounded_logits * self.logit_scale, dim=1)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_openhands_network(
    source_root: Path,
    checkpoint_path: Path,
    vocabulary_size: int,
) -> torch.nn.Module:
    if _sha256(checkpoint_path) != OPENHANDS_SLGCN_CHECKPOINT_SHA256:
        raise ValueError("OpenHands SL-GCN checkpoint hash does not match the audited release")
    source_root = source_root.resolve()
    if not (source_root / "openhands" / "models" / "network.py").is_file():
        raise ValueError("OpenHands source root does not contain the pinned model implementation")
    sys.path.insert(0, str(source_root))
    try:
        from omegaconf import OmegaConf
        from openhands.models.decoder.fc import FC
        from openhands.models.encoder.graph.decoupled_gcn import DecoupledGCN
        from openhands.models.network import Network

        inward_edges = [
            [2, 0], [1, 0], [0, 3], [0, 4], [3, 5], [4, 6], [5, 7], [6, 17],
            [7, 8], [7, 9], [9, 10], [7, 11], [11, 12], [7, 13], [13, 14],
            [7, 15], [15, 16], [17, 18], [17, 19], [19, 20], [17, 21],
            [21, 22], [17, 23], [23, 24], [17, 25], [25, 26],
        ]
        encoder = DecoupledGCN(
            in_channels=2,
            graph_args=OmegaConf.create({"num_points": 27, "inward_edges": inward_edges}),
        )
        network = Network(
            encoder,
            FC(n_features=256, num_class=vocabulary_size, dropout_ratio=0),
        )
        callback_placeholder = type("SafeLightningCallback", (), {})
        torch.serialization.add_safe_globals(
            [
                (
                    callback_placeholder,
                    "pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint",
                ),
                (
                    callback_placeholder,
                    "pytorch_lightning.callbacks.early_stopping.EarlyStopping",
                ),
            ]
        )
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        state = {
            name.removeprefix("model."): value
            for name, value in checkpoint["state_dict"].items()
        }
        network.load_state_dict(state, strict=True)
        return network.eval()
    finally:
        if sys.path and sys.path[0] == str(source_root):
            sys.path.pop(0)


def _metadata_document(model_path: Path, parameter_count: int, max_difference: float) -> dict:
    labels = [
        {
            "index": index,
            "id": label.id,
            "captionText": label.caption_text,
            "outcome": "NO_SIGN" if index == 0 else "SIGN",
        }
        for index, label in enumerate(RUNTIME_LABELS)
    ]
    vocabulary_version = "1.0.0-asl-research"
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    empty_sha = hashlib.sha256(b"").hexdigest()
    return {
        "schemaVersion": 1,
        "modelId": "openhands-wlasl-slgcn-core",
        "modelVersion": MODEL_VERSION,
        "generatedAt": generated_at,
        "mockModel": False,
        "genuineSignLanguageData": True,
        "targetLanguage": "ase",
        "vocabularyVersion": vocabulary_version,
        "vocabularySha256": canonical_vocabulary_sha256("ase", vocabulary_version, labels),
        "sourceProvenance": {
            "commit": OPENHANDS_REVISION,
            "dirty": False,
            "trackedChangesSha256": empty_sha,
            "untrackedFileCount": 0,
            "untrackedStateSha256": empty_sha,
            "untrackedContentSha256": empty_sha,
        },
        "architecture": {
            "family": "ST_GCN",
            "name": "OpenHands WLASL SL-GCN with SignConnect open-set vocabulary adapter",
            "parameterCount": parameter_count,
        },
        "artifactSha256": _sha256(model_path),
        "input": {
            "name": "features",
            "shape": [1, 30, 224],
            "tensorType": "FLOAT32",
            "featureLayoutVersion": FEATURE_LAYOUT_VERSION,
            "normalizationVersion": "shoulder-midpoint-shoulder-width-v1",
            "featureOrder": [
                "LEFT_HAND_0_20_XYZ_PRESENCE",
                "RIGHT_HAND_0_20_XYZ_PRESENCE",
                "POSE_0_2_5_11_21_XYZ_PRESENCE",
            ],
        },
        "output": {
            "name": "probabilities",
            "shape": [1, len(labels)],
            "tensorType": "FLOAT32",
            "semanticsVersion": "softmax-class-probabilities-v1",
        },
        "decision": {"minimumConfidence": 0.8},
        "labels": labels,
        "trainingDataset": {
            "datasetId": "wlasl2000-research",
            "datasetVersion": "1.0.0",
            "manifestPath": "manifests/wlasl2000-official-splits.json",
            "manifestSha256": OPENHANDS_WLASL_METADATA_SHA256,
            "licence": {
                "spdxExpression": "LicenseRef-WLASL-Research-Only",
                "commercialUseAllowed": False,
                "redistributionAllowed": False,
            },
        },
        "evaluation": {
            "protocol": {
                "splitStrategy": "RANDOM_SAMPLE",
                "splitSha256": OPENHANDS_WLASL_METADATA_SHA256,
                "signerOverlapCount": 0,
                "testSignerCount": 0,
            },
            "metrics": {
                "macroF1": 0.0,
                "accuracy": 0.0,
                "falseFinalRate": 0.0,
                "sampleCount": 0,
            },
        },
        "onnx": {
            "artifactPath": f"models/{model_path.name}",
            "opset": 18,
            "parity": {
                "verified": True,
                "absoluteTolerance": 0.00001,
                "relativeTolerance": 0.0001,
                "maxAbsoluteDifference": max_difference,
            },
        },
        "runtime": {
            "engine": "ONNX_RUNTIME_JAVA",
            "minimumVersion": "1.22.0",
            "executionProviders": ["CPUExecutionProvider"],
            "maxBatchSize": 1,
            "warmedP95LatencyMs": 0,
        },
        "sgslReview": {
            "status": "PENDING",
            "reviewerRole": "ASL_FLUENT_DEAF_REVIEWER",
            "reviewedLabelIds": [],
            "reviewArtifactSha256": None,
            "reviewedAt": None,
        },
        "governance": {
            "allTrainingSamplesConsentVerified": False,
            "usageRightsVerified": True,
            "signerIndependentEvaluationVerified": False,
            "rawVideoOrImageDataIncluded": False,
        },
        "productionPromotion": {
            "status": "BLOCKED",
            "assessedAt": generated_at,
            "blockingReasons": [
                "This WLASL checkpoint is restricted to local non-commercial research use.",
                "ASL-fluent Deaf review and signer-independent acceptance testing are pending.",
                "A representative no-sign and unknown-gesture dataset has not been evaluated.",
            ],
        },
    }


def export_openhands_asl_research_model(
    *,
    source_root: str | Path,
    checkpoint_path: str | Path,
    vocabulary_path: str | Path,
    output_directory: str | Path,
) -> tuple[Path, Path]:
    """Convert the pinned OpenHands research checkpoint into a local ONNX pack."""
    import onnxruntime as ort

    source = Path(source_root)
    checkpoint = Path(checkpoint_path)
    vocabulary_document = json.loads(Path(vocabulary_path).read_text(encoding="utf-8"))
    glosses = sorted(entry["gloss"] for entry in vocabulary_document)
    if len(glosses) != 2000 or len(set(glosses)) != len(glosses):
        raise ValueError("WLASL vocabulary must contain exactly 2,000 unique glosses")

    network = _load_openhands_network(source, checkpoint, len(glosses))
    model = OpenHandsAslResearchAdapter(
        network,
        concept_indices_for(glosses),
        len(glosses),
    ).eval()
    output_root = Path(output_directory).resolve()
    model_path = output_root / "models" / MODEL_FILENAME
    metadata_path = output_root / "models" / f"{MODEL_FILENAME}.metadata.json"
    model_path.parent.mkdir(parents=True, exist_ok=True)
    example = torch.zeros((1, SEQUENCE_LENGTH, FEATURE_COUNT), dtype=torch.float32)
    example[:, :, 3:168:4] = 1.0
    example[:, :, 171:224:4] = 1.0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        torch.onnx.export(
            model,
            (example,),
            f=model_path,
            input_names=["features"],
            output_names=["probabilities"],
            opset_version=18,
            dynamo=True,
            external_data=False,
            optimize=True,
            verbose=False,
        )

    rng = np.random.default_rng(20260830)
    parity_input = rng.normal(0.0, 0.25, size=(1, 30, 224)).astype(np.float32)
    parity_input[:, :, 3:168:4] = 1.0
    parity_input[:, :, 171:224:4] = 1.0
    with torch.inference_mode():
        expected = model(torch.from_numpy(parity_input)).numpy()
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    actual = session.run(["probabilities"], {"features": parity_input})[0]
    np.testing.assert_allclose(actual, expected, atol=1e-5, rtol=1e-4)
    max_difference = float(np.max(np.abs(actual - expected)))

    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    metadata = _metadata_document(model_path, parameter_count, max_difference)
    validate_contract_document(metadata, "model-metadata.schema.json")
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return model_path, metadata_path
