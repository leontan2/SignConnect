export const LANDMARK_SCHEMA_VERSION = 1 as const;
export const LANDMARK_CHUNK_TYPE = "landmark.chunk" as const;
export const HAND_LANDMARK_COUNT = 21;
export const POSE_LANDMARK_INDICES = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] as const;
export const VALUES_PER_LANDMARK = 4;
export const LANDMARK_FEATURE_COUNT = 224;
export const FRAMES_PER_LANDMARK_CHUNK = 5;
export const TARGET_CAPTURE_FPS = 25;
export const CAPTURE_INTERVAL_MS = 1000 / TARGET_CAPTURE_FPS;
export const BROWSER_LOCAL_GESTURE_SOURCE = "mediapipe-canned-gestures" as const;

export const BROWSER_LOCAL_GESTURE_LABELS = [
  "Closed_Fist",
  "Open_Palm",
  "Pointing_Up",
  "Thumb_Down",
  "Thumb_Up",
  "Victory",
  "ILoveYou"
] as const;

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

export type BrowserLocalGestureLabel = typeof BROWSER_LOCAL_GESTURE_LABELS[number];

export const BROWSER_LOCAL_GESTURE_DISPLAY_NAMES: Record<BrowserLocalGestureLabel, string> = {
  Closed_Fist: "Closed fist",
  Open_Palm: "Open palm",
  Pointing_Up: "Pointing up",
  Thumb_Down: "Thumbs down",
  Thumb_Up: "Thumbs up",
  Victory: "Victory",
  ILoveYou: "I love you gesture"
};

export interface BrowserLocalGesturePrediction {
  source: typeof BROWSER_LOCAL_GESTURE_SOURCE;
  label: BrowserLocalGestureLabel;
  displayName: string;
  confidence: number;
  handedness: DetectedHand["handedness"] | null;
  stable: boolean;
  consecutiveFrames: number;
}

/**
 * Ephemeral browser-only presentation data. This snapshot travels only from
 * the vision worker to the React tree; the server consumer receives only the
 * normalized `LandmarkFeatures` produced below.
 */
export interface BrowserLocalVisionFrame {
  timestampMs: number;
  gestureModel: "ready" | "unavailable";
  hands: BrowserLocalHandOverlay[];
  upperBody: BrowserLocalOverlayPoint[];
  gesture: BrowserLocalGesturePrediction | null;
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
  /** Optional so deployments can retain landmark-only capture as a fallback. */
  gestureModelUrl?: string;
}

export interface LandmarkChunkConsumer {
  isUnderPressure(): boolean;
  send(chunk: LandmarkChunk): void;
}
