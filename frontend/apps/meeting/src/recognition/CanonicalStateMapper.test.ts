import { describe, expect, it } from "vitest";

import {
  CANONICAL_APPLICATION_STATES,
  mapCanonicalApplicationState,
  type CanonicalStateInput
} from "./CanonicalStateMapper";

const ready: CanonicalStateInput = {
  camera: "on",
  recognitionEnabled: true,
  hasFrame: true,
  trackingQuality: "ready",
  calibrationReady: true,
  gesturePhase: "idle",
  recognitionOutcome: null
};

describe("CanonicalStateMapper", () => {
  it("is the single exhaustive mapper for the fixed 13 application states", () => {
    const fixtures: Array<[Partial<CanonicalStateInput>, string]> = [
      [{ camera: "off" }, "Camera off"],
      [{ camera: "initializing" }, "Camera initializing"],
      [{ trackingQuality: "no-person" }, "No person detected"],
      [{ trackingQuality: "upper-body-missing" }, "Upper body not fully visible"],
      [{ trackingQuality: "left-hand-missing" }, "Left hand missing"],
      [{ trackingQuality: "right-hand-missing" }, "Right hand missing"],
      [{ trackingQuality: "out-of-frame" }, "Hands too close to the frame edge"],
      [{ trackingQuality: "low-quality" }, "Lighting or tracking quality too poor"],
      [{}, "Ready to sign"],
      [{ gesturePhase: "active" }, "Gesture in progress"],
      [{ gesturePhase: "ready-for-inference" }, "Processing"],
      [{ recognitionOutcome: "recognized" }, "Sign recognized"],
      [{ recognitionOutcome: "not-recognized" }, "Sign not recognized"]
    ];

    expect(fixtures.map(([override]) => mapCanonicalApplicationState({ ...ready, ...override })))
      .toEqual(fixtures.map(([, expected]) => expected));
    expect(new Set(CANONICAL_APPLICATION_STATES)).toEqual(new Set(fixtures.map(([, expected]) => expected)));
  });

  it("uses lifecycle, activity, quality, calibration, and result priority deterministically", () => {
    expect(mapCanonicalApplicationState({
      ...ready,
      camera: "off",
      gesturePhase: "active",
      recognitionOutcome: "recognized"
    })).toBe("Camera off");
    expect(mapCanonicalApplicationState({
      ...ready,
      gesturePhase: "active",
      trackingQuality: "left-hand-missing",
      recognitionOutcome: "recognized"
    })).toBe("Left hand missing");
    expect(mapCanonicalApplicationState({
      ...ready,
      trackingQuality: "left-hand-missing",
      recognitionOutcome: "recognized"
    })).toBe("Left hand missing");
    expect(mapCanonicalApplicationState({
      ...ready,
      calibrationReady: false,
      recognitionOutcome: "recognized"
    })).toBe("Camera initializing");
    expect(mapCanonicalApplicationState({
      ...ready,
      gesturePhase: "ready-for-inference",
      recognitionOutcome: "recognized"
    })).toBe("Sign recognized");
    expect(mapCanonicalApplicationState({
      ...ready,
      gesturePhase: "ready-for-inference",
      recognitionOutcome: "not-recognized"
    })).toBe("Sign not recognized");
  });
});
