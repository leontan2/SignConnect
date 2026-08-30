# OpenHands WLASL checkpoint integration audit

**Audit date:** 2026-08-31
**Decision:** ACCEPT for an explicit local, noncommercial ASL research pack; BLOCK for SgSL or production promotion

## Selected first-party artifacts

The official OpenHands WLASL release candidates were compared before integration. SL-GCN was selected because its published validation score (`0.3238`) was the strongest candidate in that release and its graph model can be exported into the existing CPU ONNX boundary.

| Item | Immutable identity |
| --- | --- |
| OpenHands source | commit `fc4599d2c6a9e68d002bb2e1832a835e9b8b512d` |
| `wlasl_slgcn.zip` | SHA-256 `b37b8412d2577e30956fb8deb939091d493cad80c2936f8770b0f1cb9714eaf7` |
| SL-GCN checkpoint | `epoch=169-step=75819.ckpt`, SHA-256 `e765c49adae1adc817a8f00331bf7561775e033e58d2cc28cabcd9ee1402bc7c` |
| `wlasl_metadata.zip` | SHA-256 `4828ae6b9a630a0169feabc6ab14668e40ea95d477b842b37175e4bd8a16932a` |
| WLASL vocabulary | `splits/asl2000.json` from the verified metadata archive |

Sources: [OpenHands](https://github.com/AI4Bharat/OpenHands), [official checkpoint release](https://github.com/AI4Bharat/OpenHands/releases/tag/checkpoints_v1), and [WLASL terms](https://github.com/dxli94/WLASL).

## Runtime contract

- Language/task: American Sign Language (`ase`), isolated-sign classification.
- Public input: SignConnect `float32 [1,30,224]`, feature layout `mediapipe-holistic-224-v2`.
- Internal adapter: the 30 browser frames are uniformly resampled to the checkpoint's exact 64-frame window, then mapped to 27 OpenHands graph points in XY—pose 0, 2, 5, 11, 12, 13, 14 plus ten selected points from each hand.
- Output: probabilities for `NO_SIGN` and ten bounded concepts: Hello, Thank you, Yes, No, Help, Repeat, Slower, Understand, Finished, and Goodbye.
- Execution: self-contained ONNX through the existing Java ONNX Runtime service; no Python process is required while the app runs.
- Provenance: `mockModel: false`, `genuineSignLanguageData: true`, target language `ase`, and production promotion `BLOCKED`.

The browser v2 feature contract retains the three pose points missing from v1 and uses the same shoulder-centered, shoulder-width-scaled representation expected by the exported adapter. Missing coordinates use the pretrained pipeline's normalized-origin sentinel with an authoritative zero presence mask.

## Rejection and product limits

The released WLASL classifier is closed-set and has no trained `NO_SIGN`. SignConnect therefore wraps it with a frozen, bounded concept adapter: supported gloss aliases are aggregated; the strongest unsupported WLASL class competes through a calibrated margin; and an all-missing hand sequence deterministically returns `NO_SIGN`. Unsupported or ambiguous results do not create transcript captions.

This layer is sufficient for the local ten-concept research demonstration, not evidence of general open-world rejection. WLASL is ASL and its distribution is restricted to academic/computational use. The pack must never be described as SgSL, commercial-ready, continuous translation, or support for every sign language.

## Validation evidence

- Python export tests verify hashes, exact point mapping, vocabulary binding, ONNX parity, and metadata fail-closed behavior.
- Representative WLASL-listed clips for all ten requested concepts passed through the browser, MediaPipe, WebSocket, and ONNX path. Three additional Repeat runs passed the same path to stress the gesture boundary that had been stalling.
- One noisy “finish” recording classified as Help and was rejected as a validation exemplar; a separate WLASL-listed finish recording classified as Finished. This is evidence of model and recording variability, not universal signer accuracy.
- A real Java inference request returned `HELLO` / `Hello`, `mockModel: false`, and model version `asl-wlasl-slgcn-core-v2`.
- The complete meeting/WebSocket test assembled six browser-compatible chunks and broadcast the final caption.
- Chromium virtual webcams exercised MediaPipe, calibration, gesture segmentation, WebSocket transport, Java ONNX inference, and the rendered transcript for every supported concept. Recognized results remained visible in the persistent camera result card after the transient status expired.

These are integration and representative smoke results, not signer-independent production accuracy claims.

## Reproduction

```powershell
.\scripts\setup-asl-research-model.ps1
.\scripts\start-local-asl-research.ps1
```

Generated downloads and runtime artifacts remain outside version control. The separate production lane still requires approved SgSL rights and consent, SgSL-fluent Deaf review, signer-diverse data, trained negative/unknown examples, locked signer-independent evaluation, fairness evidence, and physical-device validation.
