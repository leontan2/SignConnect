import React from "react";

import activeToIdleSequence from "../../../../../contracts/sign-recognition/v1/fixtures/active-to-idle.sequence.json";
import { createMeetingApp } from "../MeetingApp";
import type {
  BrowserLocalTrackingQualityState,
  BrowserLocalVisionFrame
} from "./contracts";
import type { GestureCandidateFrame } from "./trackingQuality";
import type { LandmarkWorkerCommand, LandmarkWorkerLike, LandmarkWorkerResult } from "./workerProtocol";

const FIXTURE_ENABLED = process.env.RECOGNITION_E2E_FIXTURE_ENABLED === "true";
const replayFrames = activeToIdleSequence.chunks.flatMap((chunk) => chunk.frames);
let activeFixtureWorker: E2eFixtureWorker | null = null;

const FIXTURE_QUALITY_STATES: BrowserLocalTrackingQualityState[] = [
  "no-person",
  "upper-body-missing",
  "left-hand-missing",
  "right-hand-missing",
  "out-of-frame",
  "low-quality",
  "ready"
];

function browserLocalFixtureFrame(
  sourceIndex: number,
  timestampMs: number,
  candidateJustCompleted: boolean,
  candidateCompleted: boolean
): BrowserLocalVisionFrame {
  const qualityIndex = Math.min(Math.floor(sourceIndex / 3), FIXTURE_QUALITY_STATES.length - 1);
  const state = FIXTURE_QUALITY_STATES[qualityIndex];
  const personDetected = state !== "no-person";
  const upperBodyVisible = personDetected && state !== "upper-body-missing";
  const leftHandVisible = upperBodyVisible && state !== "left-hand-missing";
  const rightHandVisible = upperBodyVisible && state !== "right-hand-missing";
  const handsInsideFrame = state !== "out-of-frame";
  const calibrationReady = sourceIndex >= (FIXTURE_QUALITY_STATES.length - 1) * 3;
  const gestureActive = sourceIndex >= FIXTURE_QUALITY_STATES.length * 3;

  return {
    timestampMs,
    gestureModel: "ready",
    hands: [],
    upperBody: [],
    gesture: null,
    trackingQuality: {
      state,
      personDetected,
      upperBodyVisible,
      leftHandVisible,
      rightHandVisible,
      handsInsideFrame
    },
    calibration: {
      state: calibrationReady ? "ready" : "collecting",
      stableFrames: calibrationReady ? 8 : Math.min(sourceIndex, 7),
      requiredStableFrames: 8
    },
    gesturePhase: candidateJustCompleted
      ? "ready-for-inference"
      : candidateCompleted
        ? "idle"
        : gestureActive
          ? "active"
          : "idle"
  };
}

export class E2eFixtureCandidateBuffer {
  private frames: GestureCandidateFrame[] = [];
  private emitted = false;

  observe(frame: GestureCandidateFrame): GestureCandidateFrame[] | null {
    if (this.emitted) return null;
    this.frames.push({ timestampMs: frame.timestampMs, features: [...frame.features] });
    if (this.frames.length < 30) return null;
    const candidate = this.frames;
    this.frames = [];
    this.emitted = true;
    return candidate;
  }

  reset(): void {
    this.frames = [];
    this.emitted = false;
  }
}

export class E2eFixtureReplayGate {
  private readonly frameCount: number;
  private reservedStreamId: string | null = null;
  private authorized = false;
  private frameIndex = 0;

  constructor(frameCount: number) {
    if (!Number.isInteger(frameCount) || frameCount <= 0) {
      throw new RangeError("The E2E fixture replay requires a positive frame count.");
    }
    this.frameCount = frameCount;
  }

  observeSuccessfullySent(data: unknown): boolean {
    if (typeof data !== "string") return false;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      event = parsed as Record<string, unknown>;
    } catch {
      return false;
    }

    if (event.type === "signer.request" && typeof event.streamId === "string") {
      this.reservedStreamId = event.streamId;
      this.authorized = false;
      this.frameIndex = 0;
      return false;
    }

    if (event.type !== "recognition.control"
      || event.action !== "start"
      || typeof event.streamId !== "string"
      || event.streamId !== this.reservedStreamId
      || this.authorized) {
      return false;
    }

    this.authorized = true;
    this.frameIndex = 0;
    return true;
  }

  nextSourceIndex(): number {
    if (!this.authorized) return 0;
    const sourceIndex = this.frameIndex < this.frameCount ? this.frameIndex : 0;
    this.frameIndex += 1;
    return sourceIndex;
  }
}

class FixtureFrame implements Pick<ImageBitmap, "close"> {
  close(): void {
    // The compile-time adapter never creates or retains pixels.
  }
}

class E2eFixtureWorker implements LandmarkWorkerLike {
  onmessage: ((event: MessageEvent<LandmarkWorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly replayGate = new E2eFixtureReplayGate(replayFrames.length);
  private readonly candidateBuffer = new E2eFixtureCandidateBuffer();
  private terminated = false;
  private candidateCompleted = false;

  constructor() {
    activeFixtureWorker = this;
  }

  postMessage(message: LandmarkWorkerCommand): void {
    if (this.terminated) return;
    if (message.type === "worker.initialize") {
      queueMicrotask(() => this.emit({ type: "worker.ready" }));
      return;
    }
    if (message.type === "worker.dispose") {
      this.terminate();
      return;
    }

    const sourceIndex = this.replayGate.nextSourceIndex();
    const source = replayFrames[sourceIndex];
    const gestureCandidate = this.candidateBuffer.observe({
      timestampMs: message.timestampMs,
      features: source.features
    });
    if (gestureCandidate) this.candidateCompleted = true;
    message.frame.close();

    const frameKind = source.features
      .slice(0, 168)
      .some((value, index) => index % 4 === 3 && value === 1)
      ? "active"
      : "idle";
    const result: LandmarkWorkerResult = {
      type: "frame.result",
      requestId: message.requestId,
      timestampMs: message.timestampMs,
      result: {
        kind: "accepted",
        frameKind,
        features: [...source.features]
      },
      browserLocal: browserLocalFixtureFrame(
        sourceIndex,
        message.timestampMs,
        Boolean(gestureCandidate),
        this.candidateCompleted
      ),
      ...(gestureCandidate ? { gestureCandidate } : {})
    };
    queueMicrotask(() => this.emit(result));
  }

  terminate(): void {
    this.terminated = true;
    this.candidateCompleted = false;
    this.candidateBuffer.reset();
    if (activeFixtureWorker === this) activeFixtureWorker = null;
  }

  observeSuccessfullySent(data: unknown): void {
    if (this.replayGate.observeSuccessfullySent(data)) {
      this.candidateCompleted = false;
      this.candidateBuffer.reset();
    }
  }

  private emit(result: LandmarkWorkerResult): void {
    if (!this.terminated) this.onmessage?.({ data: result } as MessageEvent<LandmarkWorkerResult>);
  }
}

function fixtureSocketFactory(url: string): WebSocket {
  const socket = new WebSocket(url);
  const nativeSend = socket.send.bind(socket);
  socket.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    nativeSend(data);
    activeFixtureWorker?.observeSuccessfullySent(data);
  }) as WebSocket["send"];
  return socket;
}

if (!FIXTURE_ENABLED) {
  throw new Error("The E2E fixture adapter was compiled without its test-only build flag.");
}

const FixtureMeetingApp = createMeetingApp({
  socketFactory: fixtureSocketFactory,
  captureOptions: {
    workerFactory: () => new E2eFixtureWorker(),
    frameFactory: () => new FixtureFrame() as ImageBitmap
  }
});

function E2eFixtureMeetingApp(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      {
        "aria-label": "Automated fixture capture notice",
        "data-testid": "e2e-fixture-capture-notice",
        role: "note",
        style: {
          background: "#fff4d6",
          border: "2px solid #7a5700",
          color: "#3d2b00",
          fontFamily: "sans-serif",
          fontSize: "14px",
          fontWeight: 700,
          margin: "0 auto 12px",
          maxWidth: "1400px",
          padding: "10px 14px"
        }
      },
      "Automated E2E fixture capture is active. Synthetic normalized landmarks are replayed; this is not SGSL recognition."
    ),
    React.createElement(FixtureMeetingApp)
  );
}

export default E2eFixtureMeetingApp;
