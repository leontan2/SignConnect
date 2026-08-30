export const LANDMARK_SCHEMA_VERSION = 1 as const;
export const LANDMARK_CHUNK_TYPE = "landmark.chunk" as const;
export const HAND_LANDMARK_COUNT = 21;
export const POSE_LANDMARK_INDICES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] as const;
export const VALUES_PER_LANDMARK = 4;
export const LANDMARK_FEATURE_COUNT = 224;
export const FRAMES_PER_LANDMARK_CHUNK = 5;
export const TARGET_CAPTURE_FPS = 25;
export const CAPTURE_INTERVAL_MS = 1000 / TARGET_CAPTURE_FPS;

export const FEATURE_LAYOUT = {
  leftHand: { start: 0, end: 83, landmarkCount: HAND_LANDMARK_COUNT },
  rightHand: { start: 84, end: 167, landmarkCount: HAND_LANDMARK_COUNT },
  pose: { start: 168, end: 223, landmarkIndices: POSE_LANDMARK_INDICES }
} as const;

export type LandmarkFeatures = number[];

export interface LandmarkFrame {
  sequence: number;
  timestampMs: number;
  features: LandmarkFeatures;
}

export interface LandmarkChunk {
  schemaVersion: typeof LANDMARK_SCHEMA_VERSION;
  type: typeof LANDMARK_CHUNK_TYPE;
  streamId: string;
  sequence: number;
  frames: LandmarkFrame[];
}

export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export interface DetectedHand {
  handedness: "Left" | "Right";
  score: number;
  landmarks: RawLandmark[];
}

export interface LandmarkDetection {
  hands: DetectedHand[];
  poseLandmarks?: RawLandmark[];
}

/**
 * Lightweight coordinates used only to paint the local camera overlay. They
 * deliberately exclude depth and are never added to a landmark chunk.
 */
export interface BrowserLocalOverlayPoint {
  index: number;
  x: number;
  y: number;
  confidence?: number;
}

export interface BrowserLocalHandOverlay {
  handedness: DetectedHand["handedness"] | "Unknown";
  score: number;
  points: BrowserLocalOverlayPoint[];
}

export type BrowserLocalTrackingQualityState =
  | "no-person"
  | "upper-body-missing"
  | "left-hand-missing"
  | "right-hand-missing"
  | "out-of-frame"
  | "low-quality"
  | "ready";

export interface BrowserLocalTrackingQualityFacts {
  state: BrowserLocalTrackingQualityState;
  personDetected: boolean;
  upperBodyVisible: boolean;
  leftHandVisible: boolean;
  rightHandVisible: boolean;
  handsInsideFrame: boolean;
}

export interface BrowserLocalCalibrationState {
  state: "collecting" | "ready";
  stableFrames: number;
  requiredStableFrames: number;
}

export type BrowserLocalGesturePhase =
  | "idle"
  | "starting"
  | "active"
  | "ending"
  | "ready-for-inference";

/**
 * Ephemeral browser-only presentation data. This snapshot travels only from
 * the vision worker to the React tree; the server consumer receives only the
 * normalized `LandmarkFeatures` produced below.
 */
export interface BrowserLocalVisionFrame {
  timestampMs: number;
  hands: BrowserLocalHandOverlay[];
  upperBody: BrowserLocalOverlayPoint[];
  trackingQuality: BrowserLocalTrackingQualityFacts;
  calibration: BrowserLocalCalibrationState;
  gesturePhase: BrowserLocalGesturePhase;
}

export type LandmarkFrameKind = "active" | "idle";

export type LandmarkQualityRejection =
  | "INADEQUATE_ANCHORS"
  | "LOW_QUALITY"
  | "NON_FINITE"
  | "OUTLIER";

export type LandmarkNormalizationResult =
  | {
    kind: "accepted";
    frameKind: LandmarkFrameKind;
    features: LandmarkFeatures;
  }
  | {
    kind: "rejected";
    reason: LandmarkQualityRejection;
  };

export type LandmarkCaptureStatus =
  | "stopped"
  | "model-loading"
  | "camera-waiting"
  | "ready"
  | "tracking"
  | "no-hands"
  | "low-quality"
  | "unavailable"
  | "error";

export interface VisionAssetLocations {
  wasmRootUrl: string;
  handModelUrl: string;
  poseModelUrl: string;
}

export interface LandmarkChunkConsumer {
  isUnderPressure(): boolean;
  send(chunk: LandmarkChunk): void;
}
