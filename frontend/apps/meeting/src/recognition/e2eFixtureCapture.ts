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

class FixtureFrame implements Pick<ImageBitmap, "close"> {
  close(): void {
    // The compile-time adapter never creates or retains pixels.
  }
}

class E2eFixtureWorker implements LandmarkWorkerLike {
  onmessage: ((event: MessageEvent<LandmarkWorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly cycle = ++replayCycle;
  private frameIndex = 0;
  private terminated = false;
  private announcedCompletion = false;

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

    const sourceIndex = this.frameIndex < replayFrames.length
      ? this.frameIndex
      : 0;
    const source = replayFrames[sourceIndex];
    this.frameIndex += 1;
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
  }

  private emit(result: LandmarkWorkerResult): void {
    if (!this.terminated) this.onmessage?.({ data: result } as MessageEvent<LandmarkWorkerResult>);
  }
}

if (!FIXTURE_ENABLED) {
  throw new Error("The E2E fixture adapter was compiled without its test-only build flag.");
}

const FixtureMeetingApp = createMeetingApp({
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
