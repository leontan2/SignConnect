import type {
  BrowserLocalGesturePhase,
  BrowserLocalTrackingQualityState
} from "./contracts";

export const CANONICAL_APPLICATION_STATES = [
  "Camera off",
  "Camera initializing",
  "No person detected",
  "Upper body not fully visible",
  "Left hand missing",
  "Right hand missing",
  "Hands too close to the frame edge",
  "Lighting or tracking quality too poor",
  "Ready to sign",
  "Gesture in progress",
  "Processing",
  "Sign recognized",
  "Sign not recognized"
] as const;

export type CanonicalApplicationState = typeof CANONICAL_APPLICATION_STATES[number];

export interface CanonicalStateInput {
  camera: "off" | "initializing" | "on";
  recognitionEnabled: boolean;
  hasFrame: boolean;
  trackingQuality: BrowserLocalTrackingQualityState | null;
  calibrationReady: boolean;
  gesturePhase: BrowserLocalGesturePhase | null;
  recognitionOutcome: "recognized" | "not-recognized" | null;
}

const QUALITY_STATE: Record<BrowserLocalTrackingQualityState, CanonicalApplicationState> = {
  "no-person": "No person detected",
  "upper-body-missing": "Upper body not fully visible",
  "left-hand-missing": "Left hand missing",
  "right-hand-missing": "Right hand missing",
  "out-of-frame": "Hands too close to the frame edge",
  "low-quality": "Lighting or tracking quality too poor",
  ready: "Ready to sign"
};

export function mapCanonicalApplicationState(input: CanonicalStateInput): CanonicalApplicationState {
  if (input.camera === "off") return "Camera off";
  if (input.camera === "initializing" || !input.recognitionEnabled || !input.hasFrame) {
    return "Camera initializing";
  }
  if (input.trackingQuality && input.trackingQuality !== "ready") {
    return QUALITY_STATE[input.trackingQuality];
  }
  if (!input.calibrationReady) return "Camera initializing";
  if (input.gesturePhase === "starting"
    || input.gesturePhase === "active"
    || input.gesturePhase === "ending") {
    return "Gesture in progress";
  }
  if (input.recognitionOutcome === "recognized") return "Sign recognized";
  if (input.recognitionOutcome === "not-recognized") return "Sign not recognized";
  if (input.gesturePhase === "ready-for-inference") return "Processing";
  return "Ready to sign";
}
