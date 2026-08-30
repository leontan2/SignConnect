import React from "react";

import activeToIdleSequence from "../../../../../contracts/sign-recognition/v1/fixtures/active-to-idle.sequence.json";
import { createMeetingApp } from "../MeetingApp";
import type { LandmarkWorkerCommand, LandmarkWorkerLike, LandmarkWorkerResult } from "./workerProtocol";

const FIXTURE_ENABLED = process.env.RECOGNITION_E2E_FIXTURE_ENABLED === "true";
const COMPLETION_EVENT = "signconnect:e2e-fixture-completion";
const replayFrames = activeToIdleSequence.chunks.flatMap((chunk) => chunk.frames);
const firstIdleFrameIndex = replayFrames.findIndex((frame) =>
  frame.features.slice(0, 168).every((value, index) => index % 4 !== 3 || value === 0)
);
let replayCycle = 0;
let activeFixtureWorker: E2eFixtureWorker | null = null;

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
  private readonly cycle = ++replayCycle;
  private readonly replayGate = new E2eFixtureReplayGate(replayFrames.length);
  private terminated = false;
  private announcedCompletion = false;

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
    message.frame.close();

    if (!this.announcedCompletion && sourceIndex === firstIdleFrameIndex) {
      this.announcedCompletion = true;
      window.dispatchEvent(new CustomEvent(COMPLETION_EVENT, {
        detail: { cycle: this.cycle }
      }));
    }

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
      }
    };
    queueMicrotask(() => this.emit(result));
  }

  terminate(): void {
    this.terminated = true;
    if (activeFixtureWorker === this) activeFixtureWorker = null;
  }

  observeSuccessfullySent(data: unknown): void {
    if (this.replayGate.observeSuccessfullySent(data)) {
      this.announcedCompletion = false;
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
