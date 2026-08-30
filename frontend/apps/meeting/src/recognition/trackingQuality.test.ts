import { describe, expect, it } from "vitest";

import type { DetectedHand, LandmarkDetection, RawLandmark } from "./contracts";
import {
  GestureSegmenter,
  SessionCalibrator,
  evaluateTrackingQuality,
  resampleGestureCandidate
} from "./trackingQuality";

function point(x: number, y: number, visibility = 0.95): RawLandmark {
  return { x, y, z: 0, visibility, presence: 1 };
}

function upperBody(visibility = 0.95): RawLandmark[] {
  const pose = Array.from({ length: 33 }, () => point(0, 0, 0));
  pose[11] = point(0.35, 0.3, visibility);
  pose[12] = point(0.65, 0.3, visibility);
  pose[13] = point(0.3, 0.48, visibility);
  pose[14] = point(0.7, 0.48, visibility);
  pose[15] = point(0.28, 0.64, visibility);
  pose[16] = point(0.72, 0.64, visibility);
  for (let index = 17; index <= 24; index += 1) pose[index] = point(0.5, 0.7, visibility);
  return pose;
}

function hand(handedness: DetectedHand["handedness"], x: number, score = 0.95): DetectedHand {
  return {
    handedness,
    score,
    landmarks: Array.from({ length: 21 }, (_unused, index) => (
      point(x + (index % 4) * 0.005, 0.52 + Math.floor(index / 4) * 0.008)
    ))
  };
}

function detection(options: {
  leftX?: number | null;
  rightX?: number | null;
  score?: number;
  pose?: RawLandmark[];
} = {}): LandmarkDetection {
  const leftX = options.leftX === undefined ? 0.42 : options.leftX;
  const rightX = options.rightX === undefined ? 0.58 : options.rightX;
  return {
    hands: [
      ...(leftX === null ? [] : [hand("Left", leftX, options.score)]),
      ...(rightX === null ? [] : [hand("Right", rightX, options.score)])
    ],
    poseLandmarks: options.pose ?? upperBody()
  };
}

function featureFrame(timestampMs: number, coordinate: number, firstPointPresent = true) {
  const features = Array.from({ length: 56 }, () => [coordinate, coordinate, coordinate, 1]).flat();
  if (!firstPointPresent) features.splice(0, 4, 0, 0, 0, 0);
  return { timestampMs, features };
}

describe("browser-local tracking quality", () => {
  it("reports actionable categorical facts without exposing landmark values", () => {
    const cases: Array<[LandmarkDetection, string]> = [
      [{ hands: [] }, "no-person"],
      [detection({ pose: Array.from({ length: 33 }, () => point(0, 0, 0)) }), "upper-body-missing"],
      [detection({ leftX: null }), "left-hand-missing"],
      [detection({ rightX: null }), "right-hand-missing"],
      [detection({ leftX: 0.015 }), "out-of-frame"],
      [detection({ score: 0.55 }), "low-quality"],
      [detection(), "ready"]
    ];

    for (const [sample, state] of cases) {
      const result = evaluateTrackingQuality(sample);
      expect(result.facts.state).toBe(state);
      expect(JSON.stringify(result.facts)).not.toMatch(/landmarks|coordinates|shoulderScale|confidence/i);
    }
  });

  it("calibrates only after stable ready frames and forgets the baseline on reset", () => {
    const calibrator = new SessionCalibrator({ requiredStableFrames: 3 });
    const ready = evaluateTrackingQuality(detection());

    expect(calibrator.observe(ready)).toEqual({ state: "collecting", stableFrames: 1, requiredStableFrames: 3 });
    expect(calibrator.observe(ready)).toEqual({ state: "collecting", stableFrames: 2, requiredStableFrames: 3 });
    expect(calibrator.observe(ready)).toEqual({ state: "ready", stableFrames: 3, requiredStableFrames: 3 });

    calibrator.reset();
    expect(calibrator.snapshot).toEqual({ state: "collecting", stableFrames: 0, requiredStableFrames: 3 });
  });
});

describe("gesture segmentation", () => {
  const segmenterOptions = {
    startMotionThreshold: 0.1,
    endMotionThreshold: 0.02,
    startFrames: 2,
    endFrames: 2,
    referenceFrameMs: 40
  };

  it("uses start/end hysteresis and emits one local boundary for a held gesture", () => {
    const segmenter = new GestureSegmenter(segmenterOptions);
    const samples = [
      detection(),
      detection({ leftX: 0.47, rightX: 0.63 }),
      detection({ leftX: 0.52, rightX: 0.68 }),
      detection({ leftX: 0.52, rightX: 0.68 }),
      detection({ leftX: 0.52, rightX: 0.68 }),
      detection({ leftX: 0.52, rightX: 0.68 })
    ];

    const snapshots = samples.map((sample, index) => segmenter.observe(
      sample,
      evaluateTrackingQuality(sample),
      index * 40,
      featureFrame(index * 40, index / 10)
    ));

    expect(snapshots.map(({ phase }) => phase)).toEqual([
      "idle",
      "starting",
      "active",
      "ending",
      "ready-for-inference",
      "idle"
    ]);
    expect(snapshots.filter(({ completed }) => completed)).toHaveLength(1);
    const candidates = snapshots.flatMap(({ candidate }) => candidate ? [candidate] : []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toHaveLength(30);
    expect(candidates[0].every(({ features }) => features.length === 224 && features.every(Number.isFinite))).toBe(true);
    const timestamps = candidates[0].map(({ timestampMs }) => timestampMs);
    expect(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1])).toBe(true);
  });

  it("rejects a single motion spike and resumes active when motion returns during ending", () => {
    const transient = new GestureSegmenter(segmenterOptions);
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });
    expect(transient.observe(baseline, evaluateTrackingQuality(baseline), 0).phase).toBe("idle");
    expect(transient.observe(moved, evaluateTrackingQuality(moved), 40).phase).toBe("starting");
    expect(transient.observe(moved, evaluateTrackingQuality(moved), 80)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });

    const resumed = new GestureSegmenter(segmenterOptions);
    const movedAgain = detection({ leftX: 0.52, rightX: 0.68 });
    const resumedMotion = detection({ leftX: 0.57, rightX: 0.73 });
    resumed.observe(baseline, evaluateTrackingQuality(baseline), 0);
    resumed.observe(moved, evaluateTrackingQuality(moved), 40);
    expect(resumed.observe(movedAgain, evaluateTrackingQuality(movedAgain), 80).phase).toBe("active");
    expect(resumed.observe(movedAgain, evaluateTrackingQuality(movedAgain), 120).phase).toBe("ending");
    expect(resumed.observe(resumedMotion, evaluateTrackingQuality(resumedMotion), 160).phase).toBe("active");
  });

  it("resamples by time while preserving binary missing-landmark masks", () => {
    const candidate = resampleGestureCandidate([
      featureFrame(0, 0),
      featureFrame(40, 0.5, false),
      featureFrame(80, 1)
    ], 5);

    expect(candidate).toHaveLength(5);
    expect(candidate.map((features) => features[3])).toEqual([1, 1, 0, 0, 1]);
    expect(candidate.every((features) => features.length === 224)).toBe(true);
  });

  it("normalizes motion for frame rate and shoulder distance", () => {
    const observePhase = (elapsedMs: number, shoulderWidth: number, handDelta: number) => {
      const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
      const pose = upperBody();
      pose[11] = point(0.5 - shoulderWidth / 2, 0.3);
      pose[12] = point(0.5 + shoulderWidth / 2, 0.3);
      const first = detection({
        leftX: 0.5 - shoulderWidth / 4,
        rightX: 0.5 + shoulderWidth / 4,
        pose
      });
      const moved = detection({
        leftX: 0.5 - shoulderWidth / 4 + handDelta,
        rightX: 0.5 + shoulderWidth / 4 + handDelta,
        pose
      });
      segmenter.observe(first, evaluateTrackingQuality(first), 0);
      return segmenter.observe(moved, evaluateTrackingQuality(moved), elapsedMs).phase;
    };

    expect(observePhase(40, 0.3, 0.04)).toBe("active");
    expect(observePhase(80, 0.3, 0.08)).toBe("active");
    expect(observePhase(40, 0.6, 0.08)).toBe("active");
  });

  it("resets on a missing-hand state, an incomplete calibration, or a dropped-frame gap", () => {
    const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });
    const oneHand = detection({ leftX: null, rightX: 0.68 });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 40).phase).toBe("active");
    expect(segmenter.observe(oneHand, evaluateTrackingQuality(oneHand), 80)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 120);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 160).phase).toBe("active");
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 200, featureFrame(200, 1), false)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 240);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 280).phase).toBe("active");
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 600)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });
  });
});
