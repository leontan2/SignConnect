"""Regenerate the deterministic, data-free ONNX integration fixture."""

from hashlib import sha256
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "main"
    / "resources"
    / "models"
    / "deterministic-sign-v1.onnx"
)


def main() -> None:
    weights = np.zeros((30 * 224, 2), dtype=np.float32)
    presence = np.array(
        [frame * 224 + point * 4 + 3 for frame in range(30) for point in range(42)]
    )
    weights[presence, 0] = -0.02
    weights[presence, 1] = 0.02
    bias = np.array([23.0, -23.0], dtype=np.float32)

    nodes = [
        helper.make_node("Flatten", ["features"], ["flat"], axis=1),
        helper.make_node("MatMul", ["flat", "weights"], ["scores"]),
        helper.make_node("Add", ["scores", "bias"], ["biased_scores"]),
        helper.make_node(
            "Softmax", ["biased_scores"], ["probabilities"], axis=1
        ),
    ]
    graph = helper.make_graph(
        nodes,
        "signconnect-deterministic-presence-classifier",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, [1, 30, 224])],
        [helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [1, 2])],
        [
            numpy_helper.from_array(weights, "weights"),
            numpy_helper.from_array(bias, "bias"),
        ],
    )
    model = helper.make_model(
        graph,
        producer_name="SignConnect deterministic fixture generator",
        opset_imports=[helper.make_operatorsetid("", 17)],
        ir_version=8,
    )
    onnx.checker.check_model(model)
    onnx.save(model, OUTPUT)
    print(sha256(OUTPUT.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
