from __future__ import annotations

import hashlib
import math
import re
import struct
from pathlib import Path

from .config import TrainConfig
from .constants import OUT_OF_VOCABULARY
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
    "selected_epoch",
    "evaluation_split",
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

    selection_evaluation = _bind_evaluation_to_state(
        metrics_document(best_validation, manifest, "validation"),
        model.state_dict(),
        torch,
    )
    write_evaluation(config.output_dir / "validation-selection.json", selection_evaluation)
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
            "selected_epoch": best_epoch,
            "evaluation_split": "validation",
            "evaluation": selection_evaluation,
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
    if not _integer(checkpoint["selected_epoch"], 1, len(checkpoint["history"])):
        return False
    if checkpoint["selected_epoch"] != _best_validation_epoch(checkpoint["history"]):
        return False
    if checkpoint["evaluation_split"] not in {"validation", "test"}:
        return False
    if not _valid_evaluation(checkpoint, torch):
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
    if type(metrics) is not dict or set(metrics) != {
        "macroF1",
        "accuracy",
        "falseFinalRate",
        "sampleCount",
        "perClass",
        "confusionMatrix",
        "noSignBehavior",
        "rejectionBehavior",
    }:
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
