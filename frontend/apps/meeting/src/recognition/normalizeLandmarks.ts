import {
  HAND_LANDMARK_COUNT,
  LANDMARK_FEATURE_COUNT,
  POSE_LANDMARK_INDICES,
  type DetectedHand,
  type LandmarkDetection,
  type LandmarkNormalizationResult,
  type LandmarkQualityRejection,
  type RawLandmark
} from "./contracts";

export interface LandmarkNormalizationOptions {
  minimumAnchorConfidence: number;
  minimumHandConfidence: number;
  minimumPointConfidence: number;
  minimumPosePoints: number;
  minimumHandPoints: number;
  minimumShoulderWidth: number;
  maximumShoulderWidth: number;
  maximumAbsoluteInputCoordinate: number;
  maximumAbsoluteNormalizedCoordinate: number;
}

export const DEFAULT_LANDMARK_NORMALIZATION_OPTIONS: LandmarkNormalizationOptions = {
  minimumAnchorConfidence: 0.5,
  minimumHandConfidence: 0.5,
  minimumPointConfidence: 0.5,
  minimumPosePoints: 8,
  minimumHandPoints: 8,
  minimumShoulderWidth: 0.02,
  maximumShoulderWidth: 2,
  maximumAbsoluteInputCoordinate: 4,
  maximumAbsoluteNormalizedCoordinate: 20
};

type Anchor = { x: number; y: number; z: number };

function inputIssue(point: RawLandmark | undefined, options: LandmarkNormalizationOptions): LandmarkQualityRejection | null {
  if (!point) return null;
  const values = [point.x, point.y, point.z, point.visibility, point.presence]
    .filter((value): value is number => value !== undefined);

  if (!values.every(Number.isFinite)) return "NON_FINITE";
  if ([point.x, point.y, point.z].some((value) => Math.abs(value) > options.maximumAbsoluteInputCoordinate)) {
    return "OUTLIER";
  }
  return null;
}

function isPresent(
  point: RawLandmark | undefined,
  minimumConfidence: number,
  useVisibility = true
): point is RawLandmark {
  if (!point || point.presence === 0) return false;
  return !useVisibility || point.visibility === undefined || point.visibility >= minimumConfidence;
}

function normalizedValue(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function appendPoint(
  features: number[],
  point: RawLandmark | undefined,
  center: Anchor,
  scale: number,
  minimumConfidence: number,
  options: LandmarkNormalizationOptions,
  useVisibility = true
): LandmarkQualityRejection | null {
  if (!isPresent(point, minimumConfidence, useVisibility)) {
    // v2 reproduces the pretrained OpenHands normalization contract: a
    // missing raw landmark is the normalized image origin plus a zero
    // presence mask. The mask remains authoritative for quality and motion.
    features.push(
      normalizedValue(-center.x / scale),
      normalizedValue(-center.y / scale),
      normalizedValue(-center.z / scale),
      0
    );
    return null;
  }

  const coordinates = [
    normalizedValue((point.x - center.x) / scale),
    normalizedValue((point.y - center.y) / scale),
    normalizedValue((point.z - center.z) / scale)
  ];
  if (!coordinates.every(Number.isFinite)) return "NON_FINITE";
  if (coordinates.some((value) => Math.abs(value) > options.maximumAbsoluteNormalizedCoordinate)) {
    return "OUTLIER";
  }
  features.push(coordinates[0], coordinates[1], coordinates[2], 1);
  return null;
}

function bestHand(hands: DetectedHand[], handedness: DetectedHand["handedness"]): DetectedHand | undefined {
  return hands
    .filter((hand) => hand.handedness === handedness)
    .sort((left, right) => right.score - left.score)[0];
}

export function normalizeLandmarks(
  detection: LandmarkDetection,
  overrides: Partial<LandmarkNormalizationOptions> = {}
): LandmarkNormalizationResult {
  const options = { ...DEFAULT_LANDMARK_NORMALIZATION_OPTIONS, ...overrides };
  const pose = detection.poseLandmarks;
  const leftShoulder = pose?.[11];
  const rightShoulder = pose?.[12];

  for (const point of [
    ...detection.hands.flatMap((hand) => hand.landmarks.slice(0, HAND_LANDMARK_COUNT)),
    ...POSE_LANDMARK_INDICES.map((index) => pose?.[index])
  ]) {
    const issue = inputIssue(point, options);
    if (issue) return { kind: "rejected", reason: issue };
  }

  if (detection.hands.some((hand) => !Number.isFinite(hand.score))) {
    return { kind: "rejected", reason: "NON_FINITE" };
  }
  if (!isPresent(leftShoulder, options.minimumAnchorConfidence)
    || !isPresent(rightShoulder, options.minimumAnchorConfidence)) {
    return { kind: "rejected", reason: "INADEQUATE_ANCHORS" };
  }

  const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);
  if (!Number.isFinite(shoulderWidth)) return { kind: "rejected", reason: "NON_FINITE" };
  if (shoulderWidth < options.minimumShoulderWidth || shoulderWidth > options.maximumShoulderWidth) {
    return { kind: "rejected", reason: "INADEQUATE_ANCHORS" };
  }

  const leftHand = bestHand(detection.hands, "Left");
  const rightHand = bestHand(detection.hands, "Right");
  const selectedHands = [leftHand, rightHand];
  const hasValidHand = selectedHands.some((hand) => hand
    && hand.score >= options.minimumHandConfidence
    && hand.landmarks.slice(0, HAND_LANDMARK_COUNT)
      .filter((point) => isPresent(point, options.minimumPointConfidence, false)).length >= options.minimumHandPoints);

  const posePresenceCount = POSE_LANDMARK_INDICES.reduce<number>(
    (count, index) => count + (isPresent(pose?.[index], options.minimumPointConfidence) ? 1 : 0),
    0
  );
  if (posePresenceCount < options.minimumPosePoints && !hasValidHand) {
    return { kind: "rejected", reason: "LOW_QUALITY" };
  }

  const center = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    z: (leftShoulder.z + rightShoulder.z) / 2
  };
  if (detection.hands.length > 0 && selectedHands.every((hand) => !hand || hand.score < options.minimumHandConfidence)) {
    return { kind: "rejected", reason: "LOW_QUALITY" };
  }

  const features: number[] = [];
  let presentHandPoints = 0;
  for (const hand of selectedHands) {
    if (!hand || hand.score < options.minimumHandConfidence) {
      for (let index = 0; index < HAND_LANDMARK_COUNT; index += 1) {
        appendPoint(features, undefined, center, shoulderWidth, options.minimumPointConfidence, options, false);
      }
      continue;
    }

    const handPresenceCount = hand.landmarks.slice(0, HAND_LANDMARK_COUNT)
      .filter((point) => isPresent(point, options.minimumPointConfidence, false)).length;
    if (handPresenceCount < options.minimumHandPoints) {
      return { kind: "rejected", reason: "LOW_QUALITY" };
    }
    presentHandPoints += handPresenceCount;

    for (let index = 0; index < HAND_LANDMARK_COUNT; index += 1) {
      const issue = appendPoint(
        features,
        hand.landmarks[index],
        center,
        shoulderWidth,
        options.minimumPointConfidence,
        options,
        false
      );
      if (issue) return { kind: "rejected", reason: issue };
    }
  }

  for (const poseIndex of POSE_LANDMARK_INDICES) {
    const issue = appendPoint(
      features,
      pose?.[poseIndex],
      center,
      shoulderWidth,
      options.minimumPointConfidence,
      options
    );
    if (issue) return { kind: "rejected", reason: issue };
  }

  if (features.length !== LANDMARK_FEATURE_COUNT || !features.every(Number.isFinite)) {
    return { kind: "rejected", reason: "NON_FINITE" };
  }

  return {
    kind: "accepted",
    frameKind: presentHandPoints > 0 ? "active" : "idle",
    features
  };
}
