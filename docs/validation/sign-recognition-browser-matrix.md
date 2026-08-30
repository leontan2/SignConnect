# Sign-recognition browser validation matrix

This matrix records observed full-stack results for the mock-first milestone. `PASS` means the configured project completed against the real five-process local stack; `FAIL` means it ran and failed; `NOT_RUN` means the required browser or operating-system host was unavailable. A result here is integration evidence for the bundled synthetic model, not an SGSL accuracy claim.

| Operating system | Chrome | Edge | Evidence note |
| --- | --- | --- | --- |
| Windows | PASS | PASS | Final Milestone 3 post-review runs: Chrome 16/16 and Edge 16/16 full-stack specs passed. |
| macOS | NOT_RUN | NOT_RUN | No macOS host was available during this validation. |

The default `chromium` project uses Playwright’s bundled Chromium and is the required repeatable browser gate; 16/16 full-stack specs passed on this Windows host. That suite verifies the default/production bundle remains simulator-free. The enabled development simulator path passed its separate `test:e2e:simulator` gate 1/1. Branded Chrome and Edge remain explicit matrix commands so unavailable installations do not silently substitute another executable.

The synthetic latency project passed 1/1 with one discarded warm-up and 20 measured samples from completed-gesture WebSocket dispatch to caption DOM render: nearest-rank p50 25.1 ms, p95 46.1 ms, minimum 18.8 ms, and maximum 46.5 ms against a 1000 ms budget. These fixture-backed timings are pipeline evidence, not genuine SGSL model evidence.

The final full-stack gate also found and repaired a loopback-origin mismatch between the `127.0.0.1` runner and Meeting API CORS. `MeetingApiTest.allowsTheLoopbackOriginUsedByTheFullStackRunner` now verifies that origin.

A Windows in-app physical-camera check observed a 559 x 419 preview from a 1280 x 960 stream with `object-fit: contain`, detected one signing hand, and exercised the corrected shoulder-plus-one-hand readiness path. The check also confirmed that edge and missing-hand guidance change with the live MediaPipe measurements. Recognition was stopped after the check, no screenshot or landmark values were retained, and this does not qualify a genuine SGSL caption journey. Remaining release checks are broader physical-device/signer acceptance, deployment JDK/native compatibility with ONNX Runtime 1.29.0, both branded browsers on macOS, and real SGSL model/data qualification.

## Commands

```powershell
$env:PLAYWRIGHT_HTML_OPEN = 'never'
npm run test:e2e:runner:self-test
npm run test:e2e
npm run test:e2e:installed
npm run test:e2e:simulator
npm run test:e2e:performance
npm run test:e2e:list
```

The full-stack execution scripts start their required local stack; `test:e2e:list` only lists discovered cases. The runner refuses occupied ports, requires a successful webpack compile plus HTTP readiness, retains bounded redacted logs, and cleans up only its POSIX process groups or exact Windows PID trees. Browser privacy failures report field names and shape metadata only; landmark arrays and runner control credentials are never copied into assertion messages or attachments.
