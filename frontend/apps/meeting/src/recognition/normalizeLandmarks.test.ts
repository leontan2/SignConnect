import { describe, expect, it } from "vitest";

import idleChunkFixture from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk-idle.valid.json";
import activeChunkFixture from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import { normalizeLandmarks as normalizeLandmarksUnderTest } from "./normalizeLandmarks";

type RawLandmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
};

type LandmarkDetection = {
  hands: Array<{
    handedness: "Left" | "Right";
    score: number;
    landmarks: RawLandmark[];
  }>;
  poseLandmarks?: RawLandmark[];
};

type NormalizationResult =
  | { kind: "accepted"; frameKind: "active" | "idle"; features: number[] }
  | {
    kind: "rejected";
    reason: "INADEQUATE_ANCHORS" | "LOW_QUALITY" | "NON_FINITE" | "OUTLIER";
  };

type NormalizeLandmarks = (detection: LandmarkDetection) => NormalizationResult;

function normalizerFor(_behavior: string): NormalizeLandmarks {
  return normalizeLandmarksUnderTest;
}

function landmarkFromFeatureGroup(features: number[], offset: number): RawLandmark {
  const scale = 0.5;
  const center = { x: 0.5, y: 0.5, z: 0.1 };

  return {
    x: center.x + features[offset] * scale,
    y: center.y + features[offset + 1] * scale,
    z: center.z + features[offset + 2] * scale,
    visibility: features[offset + 3]
  };
}

function detectionFromCanonicalFeatures(features: number[], includeHands = true): LandmarkDetection {
  const poseLandmarks = Array.from<RawLandmark>({ length: 33 }).fill({
    x: 0,
    y: 0,
    z: 0,
    visibility: 0
  });

  for (let poseIndex = 11; poseIndex <= 24; poseIndex += 1) {
    const featureOffset = 168 + (poseIndex - 11) * 4;
    poseLandmarks[poseIndex] = landmarkFromFeatureGroup(features, featureOffset);
  }

  if (!includeHands) {
    return { hands: [], poseLandmarks };
  }

  const left = Array.from({ length: 21 }, (_, index) => landmarkFromFeatureGroup(features, index * 4));
  const right = Array.from(
    { length: 21 },
    (_, index) => landmarkFromFeatureGroup(features, 84 + index * 4)
  );

  return {
    // Detection order deliberately differs from the anatomical contract order.
    hands: [
      { handedness: "Right", score: 0.98, landmarks: right },
      { handedness: "Left", score: 0.99, landmarks: left }
    ],
    poseLandmarks
  };
}

describe("normalizeLandmarks", () => {
  it("emits the canonical left-hand, right-hand, then pose layout as 224 finite values", () => {
    const normalizeLandmarks = normalizerFor("canonical feature layout");
    const expected = activeChunkFixture.frames[0].features;

    const result = normalizeLandmarks(detectionFromCanonicalFeatures(expected));

    expect(result).toEqual({
      kind: "accepted",
      frameKind: "active",
      features: expected
    });
    expect(result.kind === "accepted" && result.features).toHaveLength(224);
    expect(result.kind === "accepted" && result.features.every(Number.isFinite)).toBe(true);
  });

  it("accepts a tracked pose with no hands as an idle frame", () => {
    const normalizeLandmarks = normalizerFor("idle tracking");
    const expected = idleChunkFixture.frames[0].features;

    const result = normalizeLandmarks(detectionFromCanonicalFeatures(expected, false));

    expect(result).toEqual({
      kind: "accepted",
      frameKind: "idle",
      features: expected
    });
  });

  it("uses detected-hand confidence when SDK hand points have zero visibility", () => {
    const normalizeLandmarks = normalizerFor("MediaPipe hand landmark presence");
    const expected = activeChunkFixture.frames[0].features;
    const detection = detectionFromCanonicalFeatures(expected);
    for (const hand of detection.hands) {
      for (const point of hand.landmarks) point.visibility = 0;
    }

    expect(normalizeLandmarks(detection)).toEqual({
      kind: "accepted",
      frameKind: "active",
      features: expected
    });
  });

  it("zero-fills a missing landmark without shifting later feature groups", () => {
    const normalizeLandmarks = normalizerFor("missing point zero fill");
    const expected = activeChunkFixture.frames[0].features;
    const detection = detectionFromCanonicalFeatures(expected);
    detection.hands[1].landmarks.splice(7, 1, {
      x: 0,
      y: 0,
      z: 0,
      presence: 0
    });

    const result = normalizeLandmarks(detection);

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.features.slice(7 * 4, 7 * 4 + 4)).toEqual([0, 0, 0, 0]);
    expect(result.features.slice(8 * 4, 8 * 4 + 4)).toEqual(expected.slice(8 * 4, 8 * 4 + 4));
  });

  it("accepts one valid hand with only the two shoulder anchors and zero-fills unavailable landmarks", () => {
    const normalizeLandmarks = normalizerFor("single-hand shoulder-anchored tracking");
    const expected = activeChunkFixture.frames[0].features;
    const detection = detectionFromCanonicalFeatures(expected);
    detection.hands = detection.hands.filter((hand) => hand.handedness === "Left");
    for (let poseIndex = 13; poseIndex <= 24; poseIndex += 1) {
      detection.poseLandmarks![poseIndex] = {
        x: 0,
        y: 0,
        z: 0,
        presence: 0
      };
    }

    const result = normalizeLandmarks(detection);

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.frameKind).toBe("active");
    expect(result.features).toHaveLength(224);
    expect(result.features.every(Number.isFinite)).toBe(true);
    expect(result.features.slice(0, 84)).toEqual(expected.slice(0, 84));
    expect(result.features.slice(84, 168)).toEqual(Array.from({ length: 84 }, () => 0));
    expect(result.features.slice(168, 176)).toEqual(expected.slice(168, 176));
    expect(result.features.slice(176)).toEqual(Array.from({ length: 48 }, () => 0));
  });

  it("rejects a frame when either shoulder anchor is not adequately tracked", () => {
    const normalizeLandmarks = normalizerFor("anchor rejection");
    const detection = detectionFromCanonicalFeatures(activeChunkFixture.frames[0].features);
    detection.poseLandmarks![12].visibility = 0.2;

    expect(normalizeLandmarks(detection)).toEqual({
      kind: "rejected",
      reason: "INADEQUATE_ANCHORS"
    });
  });

  it("distinguishes low-quality, non-finite, and outlier input", () => {
    const normalizeLandmarks = normalizerFor("typed quality rejection");
    const lowQuality = detectionFromCanonicalFeatures(activeChunkFixture.frames[0].features, false);
    for (let index = 13; index <= 24; index += 1) {
      lowQuality.poseLandmarks![index].visibility = 0;
    }

    const nonFinite = detectionFromCanonicalFeatures(activeChunkFixture.frames[0].features);
    nonFinite.poseLandmarks![14].x = Number.NaN;

    const outlier = detectionFromCanonicalFeatures(activeChunkFixture.frames[0].features);
    outlier.hands[0].landmarks[3].x = 50;

    expect(normalizeLandmarks(lowQuality)).toEqual({ kind: "rejected", reason: "LOW_QUALITY" });
    expect(normalizeLandmarks(nonFinite)).toEqual({ kind: "rejected", reason: "NON_FINITE" });
    expect(normalizeLandmarks(outlier)).toEqual({ kind: "rejected", reason: "OUTLIER" });
  });
});
