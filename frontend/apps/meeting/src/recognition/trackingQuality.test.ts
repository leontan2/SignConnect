import { describe, expect, it } from "vitest";

import type { DetectedHand, LandmarkDetection, RawLandmark } from "./contracts";
import {
  GestureSegmenter,
  SessionCalibrator,
  evaluateTrackingQuality,
  resampleGestureCandidate,
  type TrackingQualityOptions
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

function poseAdjustedDetection(
  sample: LandmarkDetection,
  handTranslationX = 0,
  fingerArticulationX = 0
): LandmarkDetection {
  const angle = 0.05;
  const scale = 1.04;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const transform = (landmark: RawLandmark): RawLandmark => {
    const centeredX = landmark.x - 0.5;
    const centeredY = landmark.y - 0.5;
    return {
      ...landmark,
      x: 0.5 + centeredX * scale * cosine - centeredY * scale * sine + 0.05,
      y: 0.5 + centeredX * scale * sine + centeredY * scale * cosine + 0.015
    };
  };

  return {
    hands: sample.hands.map((detectedHand) => ({
      ...detectedHand,
      landmarks: detectedHand.landmarks.map((landmark, index) => {
        const adjusted = transform(landmark);
        return {
          ...adjusted,
          x: adjusted.x + handTranslationX + (index === 0 ? 0 : fingerArticulationX)
        };
      })
    })),
    poseLandmarks: sample.poseLandmarks?.map(transform)
  };
}

describe("browser-local tracking quality", () => {
  it("accepts tracked hands when both shoulder anchors are stable even if pose arms are low confidence", () => {
    const pose = upperBody();
    for (const index of [13, 14, 15, 16]) pose[index] = point(pose[index].x, pose[index].y, 0.1);

    expect(evaluateTrackingQuality(detection({ pose })).facts.state).toBe("ready");
  });

  it("accepts a one-handed sign when one hand and both shoulder anchors are tracked", () => {
    expect(evaluateTrackingQuality(detection({ rightX: null })).facts.state).toBe("ready");
  });

  it("does not become ready when shoulder anchors are present but no hands are tracked", () => {
    expect(evaluateTrackingQuality(detection({ leftX: null, rightX: null })).facts.state)
      .toBe("left-hand-missing");
  });

  it("reports actionable categorical facts without exposing landmark values", () => {
    const cases: Array<[LandmarkDetection, string, Partial<TrackingQualityOptions>?]> = [
      [{ hands: [] }, "no-person"],
      [detection({ pose: Array.from({ length: 33 }, () => point(0, 0, 0)) }), "upper-body-missing"],
      [detection({ leftX: null }), "left-hand-missing", { requireBothHands: true }],
      [detection({ rightX: null }), "right-hand-missing", { requireBothHands: true }],
      [detection({ leftX: 0.015 }), "out-of-frame"],
      [detection({ score: 0.55 }), "low-quality"],
      [detection(), "ready"]
    ];

    for (const [sample, state, overrides] of cases) {
      const result = evaluateTrackingQuality(sample, overrides);
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

  it("allows a well-tracked one-handed gesture to enter segmentation", () => {
    const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
    const baseline = detection({ rightX: null });
    const moved = detection({ leftX: 0.47, rightX: null });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);

    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 40).phase).toBe("active");
  });

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

  it("captures a stationary held sign exactly once until the signer releases it", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      staticHoldMs: 120,
      staticHoldFrames: 3,
      releaseFrames: 2
    });
    const held = detection({ rightX: null });
    const snapshots = [0, 40, 80, 120, 160, 200].map((timestampMs) => segmenter.observe(
      held,
      evaluateTrackingQuality(held),
      timestampMs,
      featureFrame(timestampMs, 0.5)
    ));

    expect(snapshots.filter(({ completed }) => completed)).toHaveLength(1);
    expect(snapshots.flatMap(({ candidate }) => candidate ? [candidate] : [])).toHaveLength(1);
    expect(snapshots.find(({ completed }) => completed)?.candidate).toHaveLength(30);
    expect(snapshots.at(-1)?.phase).toBe("idle");
  });

  it("re-arms a stationary sign only after a bounded no-hand release", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      staticHoldMs: 80,
      staticHoldFrames: 3,
      releaseFrames: 2,
      qualityGapGraceMs: 120
    });
    const held = detection({ rightX: null });
    const absent = detection({ leftX: null, rightX: null });
    const snapshots = [
      ...[0, 40, 80].map((timestampMs) => [held, timestampMs] as const),
      ...[120, 160, 240].map((timestampMs) => [absent, timestampMs] as const),
      ...[280, 320, 360].map((timestampMs) => [held, timestampMs] as const)
    ].map(([sample, timestampMs]) => segmenter.observe(
      sample,
      evaluateTrackingQuality(sample),
      timestampMs,
      featureFrame(timestampMs, 0.5)
    ));

    expect(snapshots.filter(({ completed }) => completed)).toHaveLength(2);
    expect(snapshots[5].phase).toBe("idle");
    expect(snapshots.at(-1)?.candidate).toHaveLength(30);
  });

  it("keeps an active gesture through a brief tracking-quality dropout", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      startFrames: 1,
      qualityGapGraceMs: 120
    });
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });
    const absent = detection({ leftX: null, rightX: null });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0, featureFrame(0, 0));
    expect(segmenter.observe(
      moved,
      evaluateTrackingQuality(moved),
      40,
      featureFrame(40, 0.25)
    ).phase).toBe("active");
    expect(segmenter.observe(absent, evaluateTrackingQuality(absent), 80).phase).toBe("active");
    expect(segmenter.observe(
      moved,
      evaluateTrackingQuality(moved),
      120,
      featureFrame(120, 0.5)
    ).phase).toBe("ending");
    const completed = segmenter.observe(
      moved,
      evaluateTrackingQuality(moved),
      160,
      featureFrame(160, 0.75)
    );

    expect(completed.completed).toBe(true);
    expect(completed.candidate).toHaveLength(30);
  });

  it("captures a held sign from sparse but bounded physical-camera cadence", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      maximumFrameGapMs: 200,
      qualityGapGraceMs: 120,
      staticHoldMs: 500,
      staticHoldFrames: 3
    });
    const held = detection({ rightX: null });
    const snapshots = [0, 250, 500].map((timestampMs) => segmenter.observe(
      held,
      evaluateTrackingQuality(held),
      timestampMs,
      featureFrame(timestampMs, 0.5)
    ));

    expect(snapshots.at(-1)?.completed).toBe(true);
    expect(snapshots.at(-1)?.candidate).toHaveLength(30);
  });

  it("never creates a gesture candidate when no hand is tracked", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      staticHoldMs: 80,
      staticHoldFrames: 2
    });
    const absent = detection({ leftX: null, rightX: null });
    const snapshots = [0, 40, 80, 120, 500].map((timestampMs) => segmenter.observe(
      absent,
      evaluateTrackingQuality(absent),
      timestampMs,
      featureFrame(timestampMs, 0)
    ));

    expect(snapshots.every(({ phase }) => phase === "idle")).toBe(true);
    expect(snapshots.some(({ completed, candidate }) => completed || candidate !== null)).toBe(false);
  });

  it("includes a small bounded pre-roll when motion starts a dynamic gesture", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      startFrames: 1,
      preRollFrames: 2
    });
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0, featureFrame(0, 0));
    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 40, featureFrame(40, 0.1));
    segmenter.observe(moved, evaluateTrackingQuality(moved), 80, featureFrame(80, 0.5));
    segmenter.observe(moved, evaluateTrackingQuality(moved), 120, featureFrame(120, 0.75));
    const completed = segmenter.observe(
      moved,
      evaluateTrackingQuality(moved),
      160,
      featureFrame(160, 1)
    );

    expect(completed.candidate).toHaveLength(30);
    expect(completed.candidate?.[0].features[0]).toBe(0);
  });

  it("does not re-caption a dynamic gesture while its final pose remains held", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      startFrames: 1,
      staticHoldMs: 80,
      staticHoldFrames: 3
    });
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });
    const samples = [
      [baseline, 0],
      [moved, 40],
      [moved, 80],
      [moved, 120],
      [moved, 160],
      [moved, 200],
      [moved, 240],
      [moved, 280]
    ] as const;
    const snapshots = samples.map(([sample, timestampMs]) => segmenter.observe(
      sample,
      evaluateTrackingQuality(sample),
      timestampMs,
      featureFrame(timestampMs, timestampMs / 1000)
    ));

    expect(snapshots.filter(({ completed }) => completed)).toHaveLength(1);
    expect(snapshots.at(-1)?.phase).toBe("idle");
  });

  it("re-arms for the next gesture after deliberate motion without requiring hands to disappear", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      startFrames: 1,
      staticHoldMs: 80,
      staticHoldFrames: 3,
      releaseFrames: 2
    });
    const held = detection({ leftX: 0.42, rightX: null });
    const moving = detection({ leftX: 0.57, rightX: null });
    const moved = detection({ leftX: 0.72, rightX: null });
    const samples = [
      [held, 0],
      [held, 40],
      [held, 80],
      [moving, 120],
      [moved, 160],
      [moved, 200],
      [moved, 240]
    ] as const;
    const snapshots = samples.map(([sample, timestampMs]) => segmenter.observe(
      sample,
      evaluateTrackingQuality(sample),
      timestampMs,
      featureFrame(timestampMs, timestampMs / 1000)
    ));

    expect(snapshots.filter(({ completed }) => completed)).toHaveLength(2);
    expect(snapshots.at(-1)?.candidate).toHaveLength(30);
  });

  it("completes a continuously moving one-hand gesture when the bounded capture window fills", () => {
    const segmenter = new GestureSegmenter({
      ...segmenterOptions,
      startFrames: 1,
      maximumSourceFrames: 5
    });
    const baseline = detection({ rightX: null });
    segmenter.observe(
      baseline,
      evaluateTrackingQuality(baseline),
      0,
      featureFrame(0, 0)
    );

    const snapshots = Array.from({ length: 5 }, (_unused, index) => {
      const timestampMs = (index + 1) * 40;
      const sample = detection({ leftX: 0.42 + (index + 1) * 0.05, rightX: null });
      return segmenter.observe(
        sample,
        evaluateTrackingQuality(sample),
        timestampMs,
        featureFrame(timestampMs, (index + 1) / 10)
      );
    });

    expect(snapshots.at(-1)?.phase).toBe("ready-for-inference");
    expect(snapshots.at(-1)?.completed).toBe(true);
    expect(snapshots.at(-1)?.candidate).toHaveLength(30);
    expect(snapshots.slice(0, -1).every(({ candidate }) => candidate === null)).toBe(true);
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

  it("ignores common camera and pose motion while preserving hand and finger motion", () => {
    const baseline = detection();
    const phaseAfter = (sample: LandmarkDetection) => {
      const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
      segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);
      return segmenter.observe(sample, evaluateTrackingQuality(sample), 40).phase;
    };

    expect([
      phaseAfter(poseAdjustedDetection(baseline)),
      phaseAfter({ ...poseAdjustedDetection(baseline), hands: baseline.hands }),
      phaseAfter(poseAdjustedDetection(baseline, 0.04)),
      phaseAfter(poseAdjustedDetection(baseline, 0, 0.04))
    ]).toEqual(["idle", "idle", "active", "active"]);
  });

  it("preserves finger motion when simultaneous body motion cancels its screen displacement", () => {
    const baseline = detection();
    const bodyTranslationX = 0.04;
    const translatedPose = baseline.poseLandmarks?.map((landmark) => ({
      ...landmark,
      x: landmark.x + bodyTranslationX
    }));
    const counterMovedFingers: LandmarkDetection = {
      hands: baseline.hands.map((detectedHand) => ({
        ...detectedHand,
        landmarks: detectedHand.landmarks.map((landmark, index) => ({
          ...landmark,
          x: index === 0 ? landmark.x + bodyTranslationX : landmark.x
        }))
      })),
      poseLandmarks: translatedPose
    };
    const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);

    expect(segmenter.observe(
      counterMovedFingers,
      evaluateTrackingQuality(counterMovedFingers),
      40
    ).phase).toBe("active");
  });

  it("preserves whole-hand motion when opposite body motion cancels wrist screen displacement", () => {
    const baseline = detection();
    const bodyTranslationX = 0.04;
    const counterMovedHands = (handedness: DetectedHand["handedness"] | "Both"): LandmarkDetection => ({
      hands: baseline.hands.map((detectedHand) => ({
        ...detectedHand,
        landmarks: detectedHand.landmarks.map((landmark) => ({
          ...landmark,
          x: handedness === "Both" || handedness === detectedHand.handedness
            ? landmark.x
            : landmark.x + bodyTranslationX
        }))
      })),
      poseLandmarks: baseline.poseLandmarks?.map((landmark, index) => ({
        ...landmark,
        x: (handedness === "Both" && (index === 15 || index === 16))
          || (handedness === "Left" && index === 15)
          || (handedness === "Right" && index === 16)
          ? landmark.x
          : landmark.x + bodyTranslationX
      }))
    });
    const phaseAfter = (sample: LandmarkDetection) => {
      const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
      segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);
      return segmenter.observe(sample, evaluateTrackingQuality(sample), 40).phase;
    };

    expect([
      phaseAfter(counterMovedHands("Left")),
      phaseAfter(counterMovedHands("Both"))
    ]).toEqual(["active", "active"]);
  });

  it("resets after the missing-hand grace, an incomplete calibration, or an excessive frame gap", () => {
    const segmenter = new GestureSegmenter({ ...segmenterOptions, startFrames: 1 });
    const baseline = detection();
    const moved = detection({ leftX: 0.47, rightX: 0.63 });
    const oneHand = detection({ leftX: null, rightX: 0.68 });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 0);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 40).phase).toBe("active");
    expect(segmenter.observe(
      oneHand,
      evaluateTrackingQuality(oneHand, { requireBothHands: true }),
      80
    ).phase).toBe("active");
    expect(segmenter.observe(
      oneHand,
      evaluateTrackingQuality(oneHand, { requireBothHands: true }),
      440
    )).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 480);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 520).phase).toBe("active");
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 560, featureFrame(560, 1), false)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });

    segmenter.observe(baseline, evaluateTrackingQuality(baseline), 600);
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 640).phase).toBe("active");
    expect(segmenter.observe(moved, evaluateTrackingQuality(moved), 1200)).toEqual({
      phase: "idle",
      completed: false,
      candidate: null
    });
  });
});
