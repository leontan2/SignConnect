import type {
  BrowserLocalVisionFrame,
  LandmarkNormalizationResult,
  VisionAssetLocations
} from "./contracts";
import type { GestureCandidateFrame } from "./trackingQuality";

export type LandmarkWorkerRequestId = number;

export type LandmarkWorkerCommand =
  | {
    type: "worker.initialize";
    config: VisionAssetLocations;
  }
  | {
    type: "frame.process";
    requestId: LandmarkWorkerRequestId;
    timestampMs: number;
    frame: ImageBitmap;
  }
  | {
    type: "worker.dispose";
  };

export type LandmarkWorkerErrorCode =
  | "MODEL_UNAVAILABLE"
  | "WORKER_NOT_READY"
  | "NON_MONOTONIC_TIMESTAMP"
  | "PROCESSING_FAILED";

export type LandmarkWorkerResult =
  | {
    type: "worker.ready";
  }
  | {
    type: "frame.result";
    requestId: LandmarkWorkerRequestId;
    timestampMs: number;
    result: LandmarkNormalizationResult;
    browserLocal?: BrowserLocalVisionFrame;
    /** Exactly one bounded 30-frame browser-local candidate per completed gesture. */
    gestureCandidate?: GestureCandidateFrame[];
  }
  | {
    type: "worker.error";
    code: LandmarkWorkerErrorCode;
    message: string;
    requestId?: LandmarkWorkerRequestId;
    fatal: boolean;
  };

export interface LandmarkWorkerLike {
  onmessage: ((event: MessageEvent<LandmarkWorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: LandmarkWorkerCommand, transfer?: Transferable[]): void;
  terminate(): void;
}
