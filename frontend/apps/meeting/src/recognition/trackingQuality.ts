import {
  HAND_LANDMARK_COUNT,
  LANDMARK_FEATURE_COUNT,
  type BrowserLocalCalibrationState,
  type BrowserLocalGesturePhase,
  type BrowserLocalTrackingQualityFacts,
  type DetectedHand,
  type LandmarkDetection,
  type LandmarkFeatures,
  type RawLandmark
} from "./contracts";

const SHOULDER_INDICES = [11, 12] as const;

export interface TrackingQualityOptions {
  minimumPointVisibility: number;
  minimumHandScore: number;
  minimumStrongTrackingScore: number;
  minimumVisibleHandPoints: number;
  frameEdgeMargin: number;
  minimumShoulderScale: number;
  requireBothHands: boolean;
}

export const DEFAULT_TRACKING_QUALITY_OPTIONS: TrackingQualityOptions = {
  minimumPointVisibility: 0.5,
  minimumHandScore: 0.5,
  minimumStrongTrackingScore: 0.65,
  minimumVisibleHandPoints: 17,
  frameEdgeMargin: 0.08,
  minimumShoulderScale: 0.02,
  requireBothHands: false
};

export interface TrackingQualityEvaluation {
  facts: BrowserLocalTrackingQualityFacts;
  /** Ephemeral session-local scale used for motion normalization and calibration only. */
  shoulderScale: number | null;
}

function isFinitePoint(point: RawLandmark | undefined): point is RawLandmark {
  return Boolean(point)
    && Number.isFinite(point!.x)
    && Number.isFinite(point!.y)
    && Number.isFinite(point!.z)
    && point!.presence !== 0;
}

function isVisiblePoint(point: RawLandmark | undefined, threshold: number): point is RawLandmark {
  return isFinitePoint(point)
    && (point.visibility === undefined || (Number.isFinite(point.visibility) && point.visibility >= threshold));
}

function bestHand(
  hands: readonly DetectedHand[],
  handedness: DetectedHand["handedness"]
): DetectedHand | undefined {
  return hands
    .filter((hand) => hand.handedness === handedness && Number.isFinite(hand.score))
    .sort((left, right) => right.score - left.score)[0];
}

function visibleHand(
  hand: DetectedHand | undefined,
  options: TrackingQualityOptions
): hand is DetectedHand {
  if (!hand || hand.score < options.minimumHandScore) return false;
  return hand.landmarks.slice(0, HAND_LANDMARK_COUNT).filter(isFinitePoint).length
    >= options.minimumVisibleHandPoints;
}

function handTouchesEdge(hand: DetectedHand, margin: number): boolean {
  return hand.landmarks.slice(0, HAND_LANDMARK_COUNT).some((point) => (
    isFinitePoint(point)
      && (point.x < margin || point.x > 1 - margin || point.y < margin || point.y > 1 - margin)
  ));
}

function trackingState(
  facts: Omit<BrowserLocalTrackingQualityFacts, "state">,
  strongTracking: boolean,
  requireBothHands: boolean
): BrowserLocalTrackingQualityFacts["state"] {
  if (!facts.personDetected) return "no-person";
  if (!facts.upperBodyVisible) return "upper-body-missing";
  if (!facts.leftHandVisible && !facts.rightHandVisible) return "left-hand-missing";
  if (requireBothHands && !facts.leftHandVisible) return "left-hand-missing";
  if (requireBothHands && !facts.rightHandVisible) return "right-hand-missing";
  if (!facts.handsInsideFrame) return "out-of-frame";
  return strongTracking ? "ready" : "low-quality";
}

export function evaluateTrackingQuality(
  detection: LandmarkDetection,
  overrides: Partial<TrackingQualityOptions> = {}
): TrackingQualityEvaluation {
  const options = { ...DEFAULT_TRACKING_QUALITY_OPTIONS, ...overrides };
  const pose = detection.poseLandmarks;
  const leftShoulder = pose?.[11];
  const rightShoulder = pose?.[12];
  const leftHand = bestHand(detection.hands, "Left");
  const rightHand = bestHand(detection.hands, "Right");
  const leftHandVisible = visibleHand(leftHand, options);
  const rightHandVisible = visibleHand(rightHand, options);
  const personDetected = detection.hands.some((hand) => hand.landmarks.some(isFinitePoint))
    || Boolean(pose?.some((point) => isVisiblePoint(point, options.minimumPointVisibility)));
  const upperBodyVisible = SHOULDER_INDICES.every((index) => {
    const point = pose?.[index];
    return isVisiblePoint(point, options.minimumPointVisibility)
      && point.x >= 0
      && point.x <= 1
      && point.y >= 0
      && point.y <= 1;
  });
  const shoulderScale = isVisiblePoint(leftShoulder, options.minimumPointVisibility)
    && isVisiblePoint(rightShoulder, options.minimumPointVisibility)
    ? Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y)
    : null;
  const handsInsideFrame = (!leftHandVisible || !handTouchesEdge(leftHand, options.frameEdgeMargin))
    && (!rightHandVisible || !handTouchesEdge(rightHand, options.frameEdgeMargin));
  const upperBodyStrong = SHOULDER_INDICES.every((index) => (
    isVisiblePoint(pose?.[index], options.minimumStrongTrackingScore)
  ));
  const handsStrong = (!leftHandVisible || leftHand.score >= options.minimumStrongTrackingScore)
    && (!rightHandVisible || rightHand.score >= options.minimumStrongTrackingScore);
  const strongTracking = upperBodyStrong
    && handsStrong
    && shoulderScale !== null
    && shoulderScale >= options.minimumShoulderScale;
  const baseFacts = {
    personDetected,
    upperBodyVisible,
    leftHandVisible,
    rightHandVisible,
    handsInsideFrame
  };

  return {
    facts: { state: trackingState(baseFacts, strongTracking, options.requireBothHands), ...baseFacts },
    shoulderScale
  };
}

export interface SessionCalibratorOptions {
  requiredStableFrames: number;
  maximumScaleDriftRatio: number;
}

const DEFAULT_CALIBRATOR_OPTIONS: SessionCalibratorOptions = {
  requiredStableFrames: 8,
  maximumScaleDriftRatio: 0.15
};

export class SessionCalibrator {
  private readonly options: SessionCalibratorOptions;
  private stableFrames = 0;
  private baselineShoulderScale: number | null = null;
  private calibrated = false;

  constructor(overrides: Partial<SessionCalibratorOptions> = {}) {
    this.options = { ...DEFAULT_CALIBRATOR_OPTIONS, ...overrides };
    if (!Number.isInteger(this.options.requiredStableFrames) || this.options.requiredStableFrames < 1) {
      throw new RangeError("requiredStableFrames must be a positive integer.");
    }
  }

  get snapshot(): BrowserLocalCalibrationState {
    return {
      state: this.calibrated ? "ready" : "collecting",
      stableFrames: this.stableFrames,
      requiredStableFrames: this.options.requiredStableFrames
    };
  }

  observe(evaluation: TrackingQualityEvaluation): BrowserLocalCalibrationState {
    if (this.calibrated) return this.snapshot;
    const scale = evaluation.shoulderScale;
    if (evaluation.facts.state !== "ready" || scale === null || !Number.isFinite(scale) || scale <= 0) {
      this.stableFrames = 0;
      this.baselineShoulderScale = null;
      return this.snapshot;
    }

    if (this.baselineShoulderScale === null) {
      this.baselineShoulderScale = scale;
      this.stableFrames = 1;
    } else {
      const drift = Math.abs(scale - this.baselineShoulderScale) / this.baselineShoulderScale;
      if (drift > this.options.maximumScaleDriftRatio) {
        this.baselineShoulderScale = scale;
        this.stableFrames = 1;
      } else {
        this.stableFrames += 1;
        this.baselineShoulderScale += (scale - this.baselineShoulderScale) / this.stableFrames;
      }
    }
    this.calibrated = this.stableFrames >= this.options.requiredStableFrames;
    return this.snapshot;
  }

  reset(): void {
    this.stableFrames = 0;
    this.baselineShoulderScale = null;
    this.calibrated = false;
  }
}

export interface GestureSegmenterOptions {
  startMotionThreshold: number;
  endMotionThreshold: number;
  startFrames: number;
  endFrames: number;
  referenceFrameMs: number;
  maximumFrameGapMs: number;
  maximumSourceFrames: number;
  preRollFrames: number;
  staticHoldMs: number;
  staticHoldFrames: number;
  qualityGapGraceMs: number;
  releaseFrames: number;
}

const DEFAULT_SEGMENTER_OPTIONS: GestureSegmenterOptions = {
  startMotionThreshold: 0.08,
  endMotionThreshold: 0.025,
  startFrames: 3,
  endFrames: 4,
  referenceFrameMs: 40,
  maximumFrameGapMs: 200,
  maximumSourceFrames: 90,
  preRollFrames: 4,
  staticHoldMs: 520,
  staticHoldFrames: 6,
  qualityGapGraceMs: 350,
  releaseFrames: 3
};

export interface GestureCandidateFrame {
  timestampMs: number;
  features: LandmarkFeatures;
}

export interface GestureSegmentationSnapshot {
  phase: BrowserLocalGesturePhase;
  completed: boolean;
  candidate: GestureCandidateFrame[] | null;
}

interface MotionPoint {
  screenX: number;
  screenY: number;
  poseX: number;
  poseY: number;
}

type PoseWristPoints = Map<DetectedHand["handedness"], Pick<MotionPoint, "poseX" | "poseY">>;

interface PoseMotionReference {
  centerX: number;
  centerY: number;
  shoulderAxisX: number;
  shoulderAxisY: number;
  shoulderScale: number;
}

function poseMotionReference(detection: LandmarkDetection): PoseMotionReference | null {
  const leftShoulder = detection.poseLandmarks?.[11];
  const rightShoulder = detection.poseLandmarks?.[12];
  if (!isFinitePoint(leftShoulder) || !isFinitePoint(rightShoulder)) return null;
  const shoulderX = rightShoulder.x - leftShoulder.x;
  const shoulderY = rightShoulder.y - leftShoulder.y;
  const shoulderScale = Math.hypot(shoulderX, shoulderY);
  if (!Number.isFinite(shoulderScale) || shoulderScale <= 0) return null;
  return {
    centerX: (leftShoulder.x + rightShoulder.x) / 2,
    centerY: (leftShoulder.y + rightShoulder.y) / 2,
    shoulderAxisX: shoulderX / shoulderScale,
    shoulderAxisY: shoulderY / shoulderScale,
    shoulderScale
  };
}

function motionPoints(detection: LandmarkDetection): Map<string, MotionPoint> {
  const points = new Map<string, MotionPoint>();
  const reference = poseMotionReference(detection);
  if (!reference) return points;
  for (const hand of detection.hands) {
    if (!Number.isFinite(hand.score) || hand.score < DEFAULT_TRACKING_QUALITY_OPTIONS.minimumHandScore) continue;
    hand.landmarks.slice(0, HAND_LANDMARK_COUNT).forEach((point, index) => {
      if (!isFinitePoint(point)) return;
      const offsetX = point.x - reference.centerX;
      const offsetY = point.y - reference.centerY;
      points.set(`${hand.handedness}-${index}`, {
        screenX: point.x,
        screenY: point.y,
        poseX: (offsetX * reference.shoulderAxisX + offsetY * reference.shoulderAxisY)
          / reference.shoulderScale,
        poseY: (-offsetX * reference.shoulderAxisY + offsetY * reference.shoulderAxisX)
          / reference.shoulderScale
      });
    });
  }
  return points;
}

function poseWristPoints(detection: LandmarkDetection): PoseWristPoints {
  const points: PoseWristPoints = new Map();
  const reference = poseMotionReference(detection);
  if (!reference) return points;
  for (const [handedness, index] of [["Left", 15], ["Right", 16]] as const) {
    const point = detection.poseLandmarks?.[index];
    if (!isFinitePoint(point)) continue;
    const offsetX = point.x - reference.centerX;
    const offsetY = point.y - reference.centerY;
    points.set(handedness, {
      poseX: (offsetX * reference.shoulderAxisX + offsetY * reference.shoulderAxisY)
        / reference.shoulderScale,
      poseY: (-offsetX * reference.shoulderAxisY + offsetY * reference.shoulderAxisX)
        / reference.shoulderScale
    });
  }
  return points;
}

function maximumPoseWristMotion(
  currentPoints: ReadonlyMap<DetectedHand["handedness"], Pick<MotionPoint, "poseX" | "poseY">>,
  previousPoints: ReadonlyMap<DetectedHand["handedness"], Pick<MotionPoint, "poseX" | "poseY">>
): number {
  let maximumMotion = 0;
  for (const [handedness, current] of currentPoints) {
    const previous = previousPoints.get(handedness);
    if (!previous) continue;
    maximumMotion = Math.max(
      maximumMotion,
      Math.hypot(current.poseX - previous.poseX, current.poseY - previous.poseY)
    );
  }
  return maximumMotion;
}

function relativeGestureMotion(
  currentPoints: ReadonlyMap<string, MotionPoint>,
  previousPoints: ReadonlyMap<string, MotionPoint>
): number {
  let internalMotion = 0;
  let internalPointCount = 0;
  for (const handedness of ["Left", "Right"] as const) {
    const currentWrist = currentPoints.get(`${handedness}-0`);
    const previousWrist = previousPoints.get(`${handedness}-0`);
    if (!currentWrist || !previousWrist) continue;
    for (let index = 1; index < HAND_LANDMARK_COUNT; index += 1) {
      const current = currentPoints.get(`${handedness}-${index}`);
      const previous = previousPoints.get(`${handedness}-${index}`);
      if (!current || !previous) continue;
      internalMotion += Math.hypot(
        (current.poseX - currentWrist.poseX) - (previous.poseX - previousWrist.poseX),
        (current.poseY - currentWrist.poseY) - (previous.poseY - previousWrist.poseY)
      );
      internalPointCount += 1;
    }
  }

  const currentLeftWrist = currentPoints.get("Left-0");
  const currentRightWrist = currentPoints.get("Right-0");
  const previousLeftWrist = previousPoints.get("Left-0");
  const previousRightWrist = previousPoints.get("Right-0");
  const betweenHandsMotion = currentLeftWrist && currentRightWrist
    && previousLeftWrist && previousRightWrist
    ? Math.hypot(
      (currentRightWrist.poseX - currentLeftWrist.poseX)
        - (previousRightWrist.poseX - previousLeftWrist.poseX),
      (currentRightWrist.poseY - currentLeftWrist.poseY)
        - (previousRightWrist.poseY - previousLeftWrist.poseY)
    )
    : 0;

  return Math.max(
    internalPointCount === 0 ? 0 : internalMotion / internalPointCount,
    betweenHandsMotion
  );
}

function assertCandidateFrame(frame: GestureCandidateFrame): void {
  if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) {
    throw new TypeError("Gesture candidate timestamps must be finite and non-negative.");
  }
  if (frame.features.length !== LANDMARK_FEATURE_COUNT || !frame.features.every(Number.isFinite)) {
    throw new TypeError(`Gesture candidate frames must contain ${LANDMARK_FEATURE_COUNT} finite features.`);
  }
}

function interpolateFeatures(
  left: GestureCandidateFrame,
  right: GestureCandidateFrame,
  timestampMs: number
): LandmarkFeatures {
  if (left.timestampMs === right.timestampMs) return [...left.features];
  const ratio = (timestampMs - left.timestampMs) / (right.timestampMs - left.timestampMs);
  const nearest = ratio <= 0.5 ? left.features : right.features;
  const features = new Array<number>(LANDMARK_FEATURE_COUNT);
  for (let offset = 0; offset < LANDMARK_FEATURE_COUNT; offset += 4) {
    const leftPresent = left.features[offset + 3] === 1;
    const rightPresent = right.features[offset + 3] === 1;
    if (leftPresent && rightPresent) {
      features[offset] = left.features[offset] + (right.features[offset] - left.features[offset]) * ratio;
      features[offset + 1] = left.features[offset + 1]
        + (right.features[offset + 1] - left.features[offset + 1]) * ratio;
      features[offset + 2] = left.features[offset + 2]
        + (right.features[offset + 2] - left.features[offset + 2]) * ratio;
      features[offset + 3] = 1;
    } else {
      features[offset] = nearest[offset];
      features[offset + 1] = nearest[offset + 1];
      features[offset + 2] = nearest[offset + 2];
      features[offset + 3] = nearest[offset + 3] === 1 ? 1 : 0;
    }
  }
  return features;
}

export function resampleGestureCandidateFrames(
  frames: readonly GestureCandidateFrame[],
  targetFrameCount = 30
): GestureCandidateFrame[] {
  if (!Number.isInteger(targetFrameCount) || targetFrameCount < 1) {
    throw new RangeError("targetFrameCount must be a positive integer.");
  }
  if (frames.length === 0) return [];
  frames.forEach(assertCandidateFrame);
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].timestampMs <= frames[index - 1].timestampMs) {
      throw new TypeError("Gesture candidate timestamps must increase monotonically.");
    }
  }
  if (frames.length === 1) {
    return Array.from({ length: targetFrameCount }, (_unused, index) => ({
      timestampMs: frames[0].timestampMs + index * 0.001,
      features: [...frames[0].features]
    }));
  }

  const firstTimestamp = frames[0].timestampMs;
  const lastTimestamp = frames.at(-1)!.timestampMs;
  let rightIndex = 1;
  return Array.from({ length: targetFrameCount }, (_unused, targetIndex) => {
    const ratio = targetFrameCount === 1 ? 0 : targetIndex / (targetFrameCount - 1);
    const timestampMs = firstTimestamp + (lastTimestamp - firstTimestamp) * ratio;
    while (rightIndex < frames.length - 1 && frames[rightIndex].timestampMs < timestampMs) rightIndex += 1;
    return {
      timestampMs,
      features: interpolateFeatures(frames[rightIndex - 1], frames[rightIndex], timestampMs)
    };
  });
}

export function resampleGestureCandidate(
  frames: readonly GestureCandidateFrame[],
  targetFrameCount = 30
): LandmarkFeatures[] {
  return resampleGestureCandidateFrames(frames, targetFrameCount).map((frame) => frame.features);
}

export class GestureSegmenter {
  private readonly options: GestureSegmenterOptions;
  private phase: BrowserLocalGesturePhase = "idle";
  private startStreak = 0;
  private endStreak = 0;
  private previousPoints = new Map<string, MotionPoint>();
  private previousPoseWristPoints: PoseWristPoints = new Map();
  private previousTimestampMs: number | null = null;
  private candidateFrames: GestureCandidateFrame[] = [];
  private staticFrames: GestureCandidateFrame[] = [];
  private staticHoldStartedAtMs: number | null = null;
  private awaitingRelease = false;
  private releaseStreak = 0;
  private qualityInterruptedAtMs: number | null = null;
  private recentFrames: GestureCandidateFrame[] = [];
  private dynamicSourceFrameCount = 0;

  constructor(overrides: Partial<GestureSegmenterOptions> = {}) {
    this.options = { ...DEFAULT_SEGMENTER_OPTIONS, ...overrides };
    if (this.options.endMotionThreshold >= this.options.startMotionThreshold) {
      throw new RangeError("endMotionThreshold must be lower than startMotionThreshold.");
    }
    if (!Number.isInteger(this.options.staticHoldFrames) || this.options.staticHoldFrames < 2) {
      throw new RangeError("staticHoldFrames must be an integer of at least 2.");
    }
    if (!Number.isFinite(this.options.staticHoldMs) || this.options.staticHoldMs <= 0) {
      throw new RangeError("staticHoldMs must be positive.");
    }
    if (!Number.isInteger(this.options.preRollFrames) || this.options.preRollFrames < 0) {
      throw new RangeError("preRollFrames must be a non-negative integer.");
    }
    if (!Number.isFinite(this.options.qualityGapGraceMs) || this.options.qualityGapGraceMs < 0) {
      throw new RangeError("qualityGapGraceMs must be finite and non-negative.");
    }
    if (!Number.isInteger(this.options.releaseFrames) || this.options.releaseFrames < 1) {
      throw new RangeError("releaseFrames must be a positive integer.");
    }
  }

  observe(
    detection: LandmarkDetection,
    evaluation: TrackingQualityEvaluation,
    timestampMs: number,
    frame?: GestureCandidateFrame,
    calibrationReady = true
  ): GestureSegmentationSnapshot {
    const currentPoints = motionPoints(detection);
    const currentPoseWristPoints = poseWristPoints(detection);
    const currentHasTrackableHand = currentPoints.size
      >= DEFAULT_TRACKING_QUALITY_OPTIONS.minimumVisibleHandPoints;
    const shoulderScale = evaluation.shoulderScale;
    const qualityReady = evaluation.facts.state === "ready"
      && shoulderScale !== null
      && currentHasTrackableHand;

    if (!calibrationReady) {
      this.resetPhase();
      this.candidateFrames = [];
      this.dynamicSourceFrameCount = 0;
      this.clearStaticHold();
      this.previousPoints.clear();
      this.previousPoseWristPoints.clear();
      this.previousTimestampMs = null;
      this.awaitingRelease = false;
      this.releaseStreak = 0;
      this.qualityInterruptedAtMs = null;
      this.recentFrames = [];
      return { phase: this.phase, completed: false, candidate: null };
    }

    if (!qualityReady) {
      if (this.qualityInterruptedAtMs === null) this.qualityInterruptedAtMs = timestampMs;
      if (this.awaitingRelease && !currentHasTrackableHand) {
        this.releaseStreak += 1;
        if (this.releaseStreak >= this.options.releaseFrames
          && timestampMs - this.qualityInterruptedAtMs >= this.options.qualityGapGraceMs) {
          this.awaitingRelease = false;
          this.releaseStreak = 0;
          this.resetPhase();
          this.candidateFrames = [];
          this.dynamicSourceFrameCount = 0;
          this.clearStaticHold();
          this.previousPoints.clear();
          this.previousPoseWristPoints.clear();
          this.previousTimestampMs = null;
          this.qualityInterruptedAtMs = null;
          this.recentFrames = [];
          return { phase: this.phase, completed: false, candidate: null };
        }
      }
      if (timestampMs - this.qualityInterruptedAtMs <= this.options.qualityGapGraceMs) {
        return { phase: this.phase, completed: false, candidate: null };
      }
      this.resetPhase();
      this.candidateFrames = [];
      this.dynamicSourceFrameCount = 0;
      this.clearStaticHold();
      this.previousPoints.clear();
      this.previousPoseWristPoints.clear();
      this.previousTimestampMs = null;
      this.recentFrames = [];
      return { phase: this.phase, completed: false, candidate: null };
    }

    if (this.qualityInterruptedAtMs !== null
      && timestampMs - this.qualityInterruptedAtMs > this.options.qualityGapGraceMs) {
      this.resetPhase();
      this.candidateFrames = [];
      this.dynamicSourceFrameCount = 0;
      this.clearStaticHold();
      this.previousPoints.clear();
      this.previousPoseWristPoints.clear();
      this.previousTimestampMs = null;
      this.recentFrames = [];
    }
    this.qualityInterruptedAtMs = null;
    const previousPoints = this.previousPoints;
    const previousPoseWristPoints = this.previousPoseWristPoints;
    const previousTimestampMs = this.previousTimestampMs;
    const elapsedMs = previousTimestampMs === null ? null : timestampMs - previousTimestampMs;
    const comparable = [...currentPoints.entries()].filter(([key]) => this.previousPoints.has(key));
    this.previousPoints = currentPoints;
    this.previousPoseWristPoints = currentPoseWristPoints;
    this.previousTimestampMs = timestampMs;

    const hasComparableHand = comparable.length
      >= DEFAULT_TRACKING_QUALITY_OPTIONS.minimumVisibleHandPoints;
    if (elapsedMs === null || !hasComparableHand) {
      const staticCandidate = this.observeStaticHold(frame, timestampMs);
      this.rememberRecentFrame(frame);
      return staticCandidate ?? { phase: this.phase, completed: false, candidate: null };
    }

    if (elapsedMs <= 0
      || elapsedMs > this.options.maximumFrameGapMs + this.options.qualityGapGraceMs) {
      this.resetPhase();
      this.candidateFrames = [];
      this.dynamicSourceFrameCount = 0;
      this.clearStaticHold();
      this.recentFrames = [];
      const staticCandidate = this.observeStaticHold(frame, timestampMs);
      this.rememberRecentFrame(frame);
      return staticCandidate ?? { phase: this.phase, completed: false, candidate: null };
    }

    const distance = comparable.reduce((total, [key, point]) => {
      const previous = previousPoints.get(key);
      if (!previous) return total;
      return {
        screen: total.screen + Math.hypot(
          point.screenX - previous.screenX,
          point.screenY - previous.screenY
        ),
        pose: total.pose + Math.hypot(point.poseX - previous.poseX, point.poseY - previous.poseY)
      };
    }, { screen: 0, pose: 0 });
    const screenMotion = distance.screen / comparable.length / shoulderScale!;
    const poseMotion = distance.pose / comparable.length;
    const gestureRelativeMotion = relativeGestureMotion(currentPoints, previousPoints);
    const poseWristMotion = maximumPoseWristMotion(currentPoseWristPoints, previousPoseWristPoints);
    const normalizedMotion = Math.max(
      Math.min(screenMotion, poseMotion),
      gestureRelativeMotion,
      poseWristMotion
    )
      * (this.options.referenceFrameMs / elapsedMs);
    if (this.awaitingRelease) {
      if (this.phase === "ready-for-inference") this.phase = "idle";
      if (normalizedMotion >= this.options.startMotionThreshold) {
        this.releaseStreak += 1;
        if (this.releaseStreak < this.options.releaseFrames) {
          this.rememberRecentFrame(frame);
          return { phase: this.phase, completed: false, candidate: null };
        }
        this.awaitingRelease = false;
        this.releaseStreak = 0;
        this.resetPhase();
        this.clearStaticHold();
      } else {
        this.releaseStreak = 0;
        return { phase: this.phase, completed: false, candidate: null };
      }
    }
    if (this.phase === "idle" && normalizedMotion < this.options.startMotionThreshold) {
      const staticCandidate = this.observeStaticHold(frame, timestampMs);
      if (staticCandidate) return staticCandidate;
    } else {
      this.clearStaticHold();
    }
    const previousPhase = this.phase;
    const transitioned = this.transition(normalizedMotion);
    const wasCapturing = previousPhase === "starting" || previousPhase === "active" || previousPhase === "ending";
    const isCapturing = transitioned.phase === "starting"
      || transitioned.phase === "active"
      || transitioned.phase === "ending";
    if (!wasCapturing && isCapturing) {
      this.dynamicSourceFrameCount = 0;
      this.candidateFrames = this.recentFrames.map((recentFrame) => ({
        timestampMs: recentFrame.timestampMs,
        features: [...recentFrame.features]
      }));
    }
    if (frame && (isCapturing || transitioned.completed)) {
      assertCandidateFrame(frame);
      this.dynamicSourceFrameCount += 1;
      this.candidateFrames.push({ timestampMs: frame.timestampMs, features: [...frame.features] });
      if (this.candidateFrames.length > this.options.maximumSourceFrames) {
        this.candidateFrames = this.candidateFrames.slice(-this.options.maximumSourceFrames);
      }
    }
    const captureWindowFilled = isCapturing
      && this.dynamicSourceFrameCount >= this.options.maximumSourceFrames;
    if (captureWindowFilled) {
      this.phase = "ready-for-inference";
      this.startStreak = 0;
      this.endStreak = 0;
    }
    const completed = transitioned.completed || captureWindowFilled;
    const phase = captureWindowFilled ? this.phase : transitioned.phase;
    const candidate = completed && this.candidateFrames.length > 0
      ? resampleGestureCandidateFrames(this.candidateFrames)
      : null;
    if (completed && candidate) {
      this.awaitingRelease = true;
      this.releaseStreak = 0;
      this.clearStaticHold();
      this.recentFrames = [];
    } else {
      this.rememberRecentFrame(frame);
    }
    if (completed || phase === "idle") {
      this.candidateFrames = [];
      this.dynamicSourceFrameCount = 0;
    }
    return { phase, completed, candidate };
  }

  private transition(motion: number): Omit<GestureSegmentationSnapshot, "candidate"> {
    let completed = false;
    if (this.phase === "ready-for-inference") this.phase = "idle";

    if (this.phase === "idle") {
      if (motion >= this.options.startMotionThreshold) {
        this.startStreak = 1;
        this.phase = this.options.startFrames === 1 ? "active" : "starting";
      }
    } else if (this.phase === "starting") {
      if (motion >= this.options.startMotionThreshold) {
        this.startStreak += 1;
        if (this.startStreak >= this.options.startFrames) this.phase = "active";
      } else {
        this.resetPhase();
      }
    } else if (this.phase === "active") {
      if (motion <= this.options.endMotionThreshold) {
        this.endStreak = 1;
        this.phase = this.options.endFrames === 1 ? "ready-for-inference" : "ending";
        completed = this.phase === "ready-for-inference";
      }
    } else if (this.phase === "ending") {
      if (motion >= this.options.startMotionThreshold) {
        this.phase = "active";
        this.endStreak = 0;
      } else if (motion <= this.options.endMotionThreshold) {
        this.endStreak += 1;
        if (this.endStreak >= this.options.endFrames) {
          this.phase = "ready-for-inference";
          completed = true;
        }
      }
    }
    return { phase: this.phase, completed };
  }

  private resetPhase(): void {
    this.phase = "idle";
    this.startStreak = 0;
    this.endStreak = 0;
  }

  private observeStaticHold(
    frame: GestureCandidateFrame | undefined,
    timestampMs: number
  ): GestureSegmentationSnapshot | null {
    if (this.awaitingRelease || !frame) return null;
    assertCandidateFrame(frame);
    if (this.staticHoldStartedAtMs === null) this.staticHoldStartedAtMs = timestampMs;
    this.staticFrames.push({ timestampMs: frame.timestampMs, features: [...frame.features] });
    if (this.staticFrames.length > this.options.maximumSourceFrames) this.staticFrames.shift();
    if (timestampMs - this.staticHoldStartedAtMs < this.options.staticHoldMs
      || this.staticFrames.length < this.options.staticHoldFrames) return null;

    const candidate = resampleGestureCandidateFrames(this.staticFrames);
    this.clearStaticHold();
    this.recentFrames = [];
    this.awaitingRelease = true;
    this.phase = "ready-for-inference";
    return { phase: this.phase, completed: true, candidate };
  }

  private clearStaticHold(): void {
    this.staticFrames = [];
    this.staticHoldStartedAtMs = null;
  }

  private rememberRecentFrame(frame: GestureCandidateFrame | undefined): void {
    if (!frame || this.options.preRollFrames === 0) return;
    assertCandidateFrame(frame);
    this.recentFrames.push({ timestampMs: frame.timestampMs, features: [...frame.features] });
    if (this.recentFrames.length > this.options.preRollFrames) this.recentFrames.shift();
  }

  reset(): void {
    this.resetPhase();
    this.previousPoints.clear();
    this.previousPoseWristPoints.clear();
    this.previousTimestampMs = null;
    this.candidateFrames = [];
    this.dynamicSourceFrameCount = 0;
    this.clearStaticHold();
    this.awaitingRelease = false;
    this.releaseStreak = 0;
    this.qualityInterruptedAtMs = null;
    this.recentFrames = [];
  }
}
