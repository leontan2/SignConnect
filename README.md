# SignConnect

SignConnect is a mock-first accessibility workspace for sending a signer’s camera-derived landmarks through a local inference stack and sharing finalized captions with participants in the same ephemeral meeting room.

> The bundled ONNX model and replay capture are synthetic integration assets. They demonstrate the transport, windowing, inference, and caption experience; they do **not** recognize real Singapore Sign Language (SGSL).

## Implemented product slice

| Component | Technology | Port | Responsibility |
| --- | --- | ---: | --- |
| Shell MFE | React, TypeScript, Webpack Module Federation | 3000 | Product shell and navigation |
| Meeting MFE | React, TypeScript, MediaPipe | 3001 | Consent, camera capture, landmarks, and transcript |
| Meeting service | Spring Boot MVC | 8081 | Meeting creation and lifecycle |
| Realtime service | Spring WebFlux | 8082 | WebSocket validation, recognition decisions, and caption delivery |
| Inference service | Spring Boot, ONNX Runtime | 8083 | Local-profile inference against the bundled synthetic model |

The default path is:

1. The user grants camera consent and starts a meeting.
2. The Meeting MFE extracts pose/hand landmarks locally; video frames remain in the browser.
3. A completed gesture is resampled to 30 frames and travels as six ordered, versioned landmark batches over the meeting WebSocket.
4. The realtime service assembles one candidate per completed gesture and permits only one inference request at a time; under load, a newer completed candidate may replace older pending work without mixing frames. Rolling windows are legacy opt-in behavior.
5. The inference service runs an actual `OrtSession` against the synthetic ONNX model.
6. In the default segmented mode, the realtime service immediately returns a versioned final caption for a known result or private unknown feedback. Temporal voting and idle finalization apply only to explicit legacy `ROLLING` mode.
7. The realtime room hub attaches signer identity and broadcasts the finalized caption to authenticated participants in that room.
8. Every participant adds the same caption to their transcript.

Only landmark coordinates and bounded protocol metadata cross the browser boundary. Raw camera images are not uploaded or retained. Camera permission, meeting start, and recognition start are separate user actions; failure and reconnect states are exposed as text as well as colour.

Creating a room returns a six-character share code and a short-lived signed realtime ticket. Guests join with the share code and a display name. Room membership is currently in memory, supports up to eight connections by default, and is reset when the services restart. Public room events have contiguous server sequence numbers, finalized captions are idempotent, a short-lived private resume token preserves participant identity across reconnects, and the server grants recognition upload to one active signer at a time. Recognition status, unknown-sign feedback, landmark input, and resume tokens remain connection-local.

The camera workspace uses a responsive 4:3 stage with contained, centered video and an aligned tracking overlay. This avoids the shallow horizontal crop while keeping controls in a stable dock below the preview.

## Run locally

Prerequisites: Node.js 20+, npm 10+, a compatible JDK 21, Python 3.10-3.12, and [uv](https://docs.astral.sh/uv/). Install JavaScript dependencies with `npm install` and the locked model-development environment with `uv sync --project ml/sign-recognition --extra test`. On Windows, use a process-scoped JDK/runtime compatible with ONNX Runtime; do not replace installed JDK or System32 DLLs.

Start each backend service in its own terminal:

On managed Windows hosts where Java cannot establish its internal loopback socket under the default long temporary directory, create `C:\jtmp` once and set `$env:TEMP = 'C:\jtmp'` plus `$env:TMP = 'C:\jtmp'` in each backend terminal. If the failure persists when launching an executable jar directly, also pass `-Djdk.net.unixdomain.tmpdir=C:\jtmp -Djava.io.tmpdir=C:\jtmp` to `java`. These settings are process-local.

```powershell
$env:JAVA_HOME = 'C:\path\to\compatible-jdk-21'
$env:SERVER_ADDRESS = '127.0.0.1'
cd backend
.\mvnw.cmd -pl meeting-service spring-boot:run
```

```powershell
$env:JAVA_HOME = 'C:\path\to\compatible-jdk-21'
$env:SPRING_PROFILES_ACTIVE = 'local'
$env:SERVER_ADDRESS = '127.0.0.1'
cd backend
.\mvnw.cmd -pl sign-inference-service spring-boot:run
```

```powershell
$env:JAVA_HOME = 'C:\path\to\compatible-jdk-21'
$env:SIGN_INFERENCE_URL = 'http://127.0.0.1:8083'
$env:SERVER_ADDRESS = '127.0.0.1'
cd backend
.\mvnw.cmd -pl realtime-service spring-boot:run
```

Smoke-check all three backend readiness endpoints before starting the frontends:

```powershell
Invoke-RestMethod http://127.0.0.1:8081/actuator/health
Invoke-RestMethod http://127.0.0.1:8082/actuator/health
Invoke-RestMethod http://127.0.0.1:8083/actuator/health/readiness
```

Then start the frontends and open `http://127.0.0.1:3000`:

```powershell
$env:MEETING_API_URL = 'http://127.0.0.1:8081'
$env:REALTIME_WS_URL = 'ws://127.0.0.1:8082'
$env:MEETING_REMOTE_URL = 'http://127.0.0.1:3001/remoteEntry.js'
npm run dev
```

The realtime simulator is disabled by default. It requires the realtime service's `development` profile (whose profile configuration explicitly enables the server property) and a Meeting remote compiled with `RECOGNITION_SIMULATOR_ENABLED=true`; setting the server property outside that profile is rejected. It remains visibly labelled in the UI. The replay capture used by end-to-end tests is selected only while compiling the Meeting remote with `RECOGNITION_E2E_FIXTURE_ENABLED=true`; there is no query-string or runtime switch for it, and ordinary builds exclude its visible test marker.

## Verify

Run the unit, type, production-build, and full Maven reactor gates:

```powershell
.\scripts\verify.ps1 -JavaHome 'C:\path\to\compatible-jdk-21'
```

The verification script also validates the versioned training contracts and runs the locked Python model, export, and ONNX parity tests. The bundled generated dataset is a mechanical non-production fixture, not SgSL training data or accuracy evidence. See [`ml/sign-recognition/README.md`](ml/sign-recognition/README.md) for the reproducible TCN/GRU commands and safety boundary.

On a managed Windows host where Java NIO cannot use the default long temporary path, set a short process-local path before the verifier or browser suites:

```powershell
$env:TEMP = 'C:\jtmp'
$env:TMP = 'C:\jtmp'
```

Install Playwright’s bundled Chromium once if it is not already cached, then run the complete local stack through the exact-process runner:

```powershell
npx playwright install chromium
$env:PLAYWRIGHT_HTML_OPEN = 'never'
npm run test:e2e:runner:self-test
npm run test:e2e
npm run test:e2e:performance
```

Branded browser runs and the explicit simulator gate are separate commands:

```powershell
npm run test:e2e:installed
npm run test:e2e:simulator
npm run test:e2e:list
```

`test:e2e`, `test:e2e:installed`, `test:e2e:simulator`, and `test:e2e:performance` all start their required stack; `test:e2e:list` is discovery-only. The runner owns each process tree it starts, requires both successful webpack compilation and HTTP readiness, applies bounded redacted logs, and tears down POSIX process groups or exact Windows PID trees. It refuses to reuse occupied service ports. Performance validation discards one warm-up cycle, measures at least 20 completed replay cycles, computes nearest-rank p95, and requires p95 below 1000 ms while retaining aggregate timings only.

See [the browser validation matrix](docs/validation/sign-recognition-browser-matrix.md) for observed host/browser results and unavailable-host gates.

## Real-model gate

Real SGSL readiness remains deferred. Replacing the synthetic model requires a consented and documented SGSL dataset, signer-independent evaluation splits, class coverage and fairness evidence, calibrated confidence/stability thresholds, an updated model card, and regression evidence through the same contracts and end-to-end harness. No current screen or test result should be interpreted as an SGSL accuracy claim.

Speech recognition, persistent transcripts, durable accounts, deployment infrastructure, WebRTC media, and production model training are future work outside this milestone.
