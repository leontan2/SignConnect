# Deterministic synthetic ONNX model

`deterministic-sign-v1.onnx` is a code-generated integration fixture. It contains no
trained weights, recordings, landmarks, or third-party dataset content, and it makes
no SGSL recognition claim. The repository's explicit `local` profile is the only
bundled configuration that selects it. Runtime loading also requires the explicit
`allow-mock-model` flag and a `local`, `development`, or `test` profile. The known
synthetic artifact digest cannot be relabeled as a real model.

The graph accepts float input `features` with shape `[1,30,224]`. It flattens the
window, counts only the 42 hand-presence positions in each frame through fixed linear
weights, and applies Softmax to emit `probabilities` with shape `[1,2]`. A fully active
shared fixture selects `MOCK_ACTIVE`; the pose-only idle fixture and the first
five-idle-frame transition window select `NO_SIGN`.

## Versioned runtime metadata

The adjacent JSON sidecar is startup-validated before ONNX Runtime becomes ready. It
implements the complete authoritative `sign-recognition-training/v1` metadata
contract: artifact and tensor details, provenance, evaluation, ONNX parity, runtime,
SGSL review, governance, and production-promotion evidence are all required. Unknown,
missing, or inconsistent fields fail readiness closed. This synthetic document is
explicitly `BLOCKED` from production promotion. Deployment configuration must also
select the same model version with `SIGN_MODEL_EXPECTED_VERSION`.

The frozen v1 inference response has no outcome discriminator. Internally, a sign
below the metadata threshold remains a sign candidate with its classifier confidence
so the realtime stabilizer can report low confidence. `NO_SIGN` and explicit
`REJECT` outcomes both cross v1 safely as `labelId: "NO_SIGN"` with
`captionText: null`; neither is a caption candidate. Model-unavailable state returns
the existing privacy-safe 503 and no prediction body.

## Service resource bounds

The prediction endpoint pre-binds at most 256 KiB per request, including requests
sent without `Content-Length`. ONNX execution defaults to four concurrent calls with
a 250 ms bounded acquisition wait. Operators may tune these limits with
`SIGN_MAX_REQUEST_BODY_BYTES`, `SIGN_MAX_CONCURRENT_PREDICTIONS`, and
`SIGN_CONCURRENCY_ACQUIRE_TIMEOUT_MS`; startup validation constrains them to
64 KiB-1 MiB, 1-16 calls, and 0-1,000 ms respectively. Capacity exhaustion returns
the value-free `INFERENCE_BUSY` response without changing model readiness.

## Reproduction

The artifact was generated with `onnx==1.22.0`, opset 17, and IR version 8 using the
checked-in `scripts/generate_deterministic_model.py` generator. The constants are deliberately transparent and do
not originate from model training:

Artifact SHA-256: `fd2cf50b2bdbe8c7c6953e0f809b33df2012de2a476b09fcff0e6987e289c4a8`.

```python
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

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
    helper.make_node("Softmax", ["biased_scores"], ["probabilities"], axis=1),
]
graph = helper.make_graph(
    nodes,
    "signconnect-deterministic-presence-classifier",
    [helper.make_tensor_value_info("features", TensorProto.FLOAT, [1, 30, 224])],
    [helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [1, 2])],
    [numpy_helper.from_array(weights, "weights"), numpy_helper.from_array(bias, "bias")],
)
model = helper.make_model(
    graph,
    producer_name="SignConnect deterministic fixture generator",
    opset_imports=[helper.make_operatorsetid("", 17)],
    ir_version=8,
)
onnx.checker.check_model(model)
onnx.save(
    model,
    Path("backend/sign-inference-service/src/main/resources/models/"
         "deterministic-sign-v1.onnx"),
)
```

## Windows runtime prerequisite

ONNX Runtime's Windows CPU build requires a current Visual C++ runtime. The Java
process must not shadow it with an older copy bundled in the JDK. In particular,
Oracle JDK 21.0.8 includes MSVC 14.36 DLLs while this ONNX Runtime 1.29.0 binary was
linked with MSVC 14.44. Use a Java 21 distribution built against a compatible Visual
C++ runtime (for example, a current Microsoft OpenJDK or Eclipse Temurin build) and
install the latest supported x64 Visual C++ Redistributable. Do not modify the
installed JDK as an application startup step.
