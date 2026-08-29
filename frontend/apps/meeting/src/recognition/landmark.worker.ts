import {
  FilesetResolver,
  GestureRecognizer,
  HandLandmarker,
  PoseLandmarker,
  type Category,
  type GestureRecognizerResult,
  type HandLandmarkerResult,
  type PoseLandmarkerResult
} from "@mediapipe/tasks-vision";

import type {
  BrowserLocalGestureLabel,
  BrowserLocalGesturePrediction,
  BrowserLocalHandOverlay,
  BrowserLocalOverlayPoint,
  BrowserLocalVisionFrame,
  DetectedHand,
  LandmarkDetection,
  RawLandmark,
  VisionAssetLocations
} from "./contracts";
import {
  BROWSER_LOCAL_GESTURE_DISPLAY_NAMES,
  BROWSER_LOCAL_GESTURE_LABELS,
  BROWSER_LOCAL_GESTURE_SOURCE,
  POSE_LANDMARK_INDICES
} from "./contracts";
import { normalizeLandmarks } from "./normalizeLandmarks";
import type { LandmarkWorkerCommand, LandmarkWorkerResult } from "./workerProtocol";

export interface HandLandmarkerTaskLike {
  detectForVideo(frame: ImageBitmap, timestampMs: number): Pick<
    HandLandmarkerResult,
    "landmarks" | "handedness" | "handednesses"
  >;
  close(): void;
}

export interface PoseLandmarkerTaskLike {
  detectForVideo(frame: ImageBitmap, timestampMs: number): Pick<PoseLandmarkerResult, "landmarks">;
  close(): void;
}

export interface GestureRecognizerTaskLike {
  recognizeForVideo(frame: ImageBitmap, timestampMs: number): Pick<
    GestureRecognizerResult,
    "landmarks" | "handedness" | "handednesses" | "gestures"
  >;
  close(): void;
}

export interface MediaPipeTaskSet {
  hand?: HandLandmarkerTaskLike;
  gesture?: GestureRecognizerTaskLike;
  pose: PoseLandmarkerTaskLike;
}

export interface MediaPipeBindings {
  FilesetResolver: Pick<typeof FilesetResolver, "forVisionTasks">;
  HandLandmarker: Pick<typeof HandLandmarker, "createFromOptions">;
  PoseLandmarker: Pick<typeof PoseLandmarker, "createFromOptions">;
  GestureRecognizer?: Pick<typeof GestureRecognizer, "createFromOptions">;
}

const defaultMediaPipeBindings: MediaPipeBindings = {
  FilesetResolver,
  GestureRecognizer,
  HandLandmarker,
  PoseLandmarker
};

const GENERIC_GESTURE_SCORE_THRESHOLD = 0.6;
const GENERIC_GESTURE_STABLE_FRAME_COUNT = 4;

function validateAssetLocations(config: VisionAssetLocations): void {
  if (![config.wasmRootUrl, config.handModelUrl, config.poseModelUrl]
    .every((location) => typeof location === "string" && location.trim().length > 0)) {
    throw new TypeError("Vision asset locations are required.");
  }
}

export async function createMediaPipeTasks(
  config: VisionAssetLocations,
  bindings: MediaPipeBindings = defaultMediaPipeBindings
): Promise<MediaPipeTaskSet> {
  validateAssetLocations(config);
  const fileset = await bindings.FilesetResolver.forVisionTasks(config.wasmRootUrl);
  let gesture: GestureRecognizerTaskLike | undefined;
  if (config.gestureModelUrl && bindings.GestureRecognizer) {
    try {
      gesture = await bindings.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: config.gestureModelUrl },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        cannedGesturesClassifierOptions: {
          scoreThreshold: GENERIC_GESTURE_SCORE_THRESHOLD,
          categoryAllowlist: [...BROWSER_LOCAL_GESTURE_LABELS]
        }
      });
    } catch {
      // The canned gesture model is a presentation-only demo. Landmark capture
      // remains available through the smaller hand task if it cannot load.
    }
  }

  let hand: HandLandmarkerTaskLike | undefined;
  if (!gesture) {
    hand = await bindings.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: config.handModelUrl },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  }

  try {
    const pose = await bindings.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: config.poseModelUrl },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false
    });
    return {
      ...(hand ? { hand } : {}),
      ...(gesture ? { gesture } : {}),
      pose
    };
  } catch {
    hand?.close();
    gesture?.close();
    throw new Error("Pose task initialization failed.");
  }
}

function anatomicalHandedness(category: Category | undefined): DetectedHand["handedness"] | null {
  const normalized = category?.categoryName.trim().toLowerCase();
  // MediaPipe labels handedness as though its input were mirrored. Capture stays
  // unmirrored, so swap the classifier label into the signer's anatomical side.
  if (normalized === "left") return "Right";
  if (normalized === "right") return "Left";
  return null;
}

function toDetection(
  handResult: Pick<HandLandmarkerResult, "landmarks" | "handedness" | "handednesses">,
  poseResult: Pick<PoseLandmarkerResult, "landmarks">
): LandmarkDetection | null {
  const classifications = handResult.handedness ?? handResult.handednesses;
  const hands: DetectedHand[] = [];

  for (let index = 0; index < handResult.landmarks.length; index += 1) {
    const category = classifications[index]?.[0];
    const handedness = anatomicalHandedness(category);
    if (!handedness || !category) continue;
    hands.push({
      handedness,
      score: category.score,
      landmarks: handResult.landmarks[index] as RawLandmark[]
    });
  }

  if (hands.length !== handResult.landmarks.length) return null;
  return {
    hands,
    poseLandmarks: poseResult.landmarks[0] as RawLandmark[] | undefined
  };
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toOverlayPoints(
  rawPoints: readonly RawLandmark[],
  selectedIndices?: readonly number[]
): BrowserLocalOverlayPoint[] {
  const indices = selectedIndices ?? rawPoints.map((_point, index) => index);
  const points: BrowserLocalOverlayPoint[] = [];

  for (const index of indices) {
    const point = rawPoints[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const confidence = point.visibility ?? point.presence;
    points.push({
      index,
      x: clampUnit(point.x),
      y: clampUnit(point.y),
      ...(Number.isFinite(confidence) ? { confidence: clampUnit(confidence!) } : {})
    });
  }
  return points;
}

function toHandOverlays(
  handResult: Pick<HandLandmarkerResult, "landmarks" | "handedness" | "handednesses">
): BrowserLocalHandOverlay[] {
  const classifications = handResult.handedness ?? handResult.handednesses;
  return handResult.landmarks.flatMap((rawPoints, index) => {
    const points = toOverlayPoints(rawPoints as RawLandmark[]);
    if (points.length === 0) return [];
    const category = classifications[index]?.[0];
    return [{
      handedness: anatomicalHandedness(category) ?? "Unknown",
      score: Number.isFinite(category?.score) ? clampUnit(category!.score) : 0,
      points
    }];
  });
}

function isGenericGestureLabel(value: string): value is BrowserLocalGestureLabel {
  return (BROWSER_LOCAL_GESTURE_LABELS as readonly string[]).includes(value);
}

function toGenericGesturePrediction(
  result: Pick<GestureRecognizerResult, "gestures" | "handedness" | "handednesses"> | undefined
): Omit<BrowserLocalGesturePrediction, "stable" | "consecutiveFrames"> | null {
  if (!result) return null;
  const handednesses = result.handedness ?? result.handednesses;
  let best: Omit<BrowserLocalGesturePrediction, "stable" | "consecutiveFrames"> | null = null;

  for (let index = 0; index < result.gestures.length; index += 1) {
    const category = result.gestures[index]?.[0];
    const label = category?.categoryName;
    if (!category || !label || !isGenericGestureLabel(label)) continue;
    if (!Number.isFinite(category.score) || category.score < GENERIC_GESTURE_SCORE_THRESHOLD) continue;
    if (best && best.confidence >= category.score) continue;
    best = {
      source: BROWSER_LOCAL_GESTURE_SOURCE,
      label,
      displayName: BROWSER_LOCAL_GESTURE_DISPLAY_NAMES[label],
      confidence: clampUnit(category.score),
      handedness: anatomicalHandedness(handednesses[index]?.[0])
    };
  }
  return best;
}

function closeTaskSet(tasks: MediaPipeTaskSet): void {
  try {
    tasks.hand?.close();
  } catch {
    // Worker teardown must continue even when an SDK close call fails.
  }
  try {
    tasks.gesture?.close();
  } catch {
    // Worker teardown must continue even when an SDK close call fails.
  }
  try {
    tasks.pose.close();
  } catch {
    // Worker teardown must continue even when an SDK close call fails.
  }
}

function closeFrame(frame: ImageBitmap): void {
  try {
    frame.close();
  } catch {
    // A transferred frame may already be detached; no media is included in errors.
  }
}

export interface LandmarkWorkerProcessorOptions {
  createTasks(config: VisionAssetLocations): Promise<MediaPipeTaskSet>;
  emit(result: LandmarkWorkerResult): void;
}

export interface LandmarkWorkerProcessor {
  handle(command: LandmarkWorkerCommand): Promise<void>;
}

export function createLandmarkWorkerProcessor(options: LandmarkWorkerProcessorOptions): LandmarkWorkerProcessor {
  let tasks: MediaPipeTaskSet | null = null;
  let lastTimestampMs = Number.NEGATIVE_INFINITY;
  let lastGestureLabel: BrowserLocalGestureLabel | null = null;
  let consecutiveGestureFrames = 0;
  let disposed = false;

  function stabilizeGesture(
    prediction: Omit<BrowserLocalGesturePrediction, "stable" | "consecutiveFrames"> | null
  ): BrowserLocalGesturePrediction | null {
    if (!prediction) {
      lastGestureLabel = null;
      consecutiveGestureFrames = 0;
      return null;
    }
    if (prediction.label === lastGestureLabel) {
      consecutiveGestureFrames += 1;
    } else {
      lastGestureLabel = prediction.label;
      consecutiveGestureFrames = 1;
    }
    return {
      ...prediction,
      stable: consecutiveGestureFrames >= GENERIC_GESTURE_STABLE_FRAME_COUNT,
      consecutiveFrames: consecutiveGestureFrames
    };
  }

  async function initialize(config: VisionAssetLocations): Promise<void> {
    if (disposed || tasks) return;
    try {
      tasks = await options.createTasks(config);
      if (disposed) {
        closeTaskSet(tasks);
        tasks = null;
        return;
      }
      options.emit({ type: "worker.ready" });
    } catch {
      options.emit({
        type: "worker.error",
        code: "MODEL_UNAVAILABLE",
        message: "Vision model is unavailable.",
        fatal: true
      });
    }
  }

  async function processFrame(command: Extract<LandmarkWorkerCommand, { type: "frame.process" }>): Promise<void> {
    try {
      if (!tasks || disposed) {
        options.emit({
          type: "worker.error",
          code: "WORKER_NOT_READY",
          message: "Vision worker is not ready.",
          requestId: command.requestId,
          fatal: false
        });
        return;
      }
      if (!Number.isFinite(command.timestampMs) || command.timestampMs < 0 || command.timestampMs <= lastTimestampMs) {
        options.emit({
          type: "worker.error",
          code: "NON_MONOTONIC_TIMESTAMP",
          message: "Frame timestamps must increase monotonically.",
          requestId: command.requestId,
          fatal: false
        });
        return;
      }

      lastTimestampMs = command.timestampMs;
      const gestureResult = tasks.gesture?.recognizeForVideo(command.frame, command.timestampMs);
      const handResult = gestureResult ?? tasks.hand?.detectForVideo(command.frame, command.timestampMs);
      if (!handResult) throw new Error("No hand tracking task is available.");
      const poseResult = tasks.pose.detectForVideo(command.frame, command.timestampMs);
      const detection = toDetection(handResult, poseResult);
      const result = detection
        ? normalizeLandmarks(detection)
        : { kind: "rejected" as const, reason: "LOW_QUALITY" as const };
      const browserLocal: BrowserLocalVisionFrame = {
        timestampMs: command.timestampMs,
        gestureModel: tasks.gesture ? "ready" : "unavailable",
        hands: toHandOverlays(handResult),
        upperBody: toOverlayPoints(
          (poseResult.landmarks[0] ?? []) as RawLandmark[],
          POSE_LANDMARK_INDICES
        ),
        gesture: stabilizeGesture(toGenericGesturePrediction(gestureResult))
      };

      options.emit({
        type: "frame.result",
        requestId: command.requestId,
        timestampMs: command.timestampMs,
        result,
        browserLocal
      });
    } catch {
      options.emit({
        type: "worker.error",
        code: "PROCESSING_FAILED",
        message: "Vision frame processing failed.",
        requestId: command.requestId,
        fatal: false
      });
    } finally {
      closeFrame(command.frame);
    }
  }

  async function handle(command: LandmarkWorkerCommand): Promise<void> {
    if (command.type === "worker.initialize") {
      await initialize(command.config);
      return;
    }
    if (command.type === "frame.process") {
      await processFrame(command);
      return;
    }

    disposed = true;
    lastGestureLabel = null;
    consecutiveGestureFrames = 0;
    if (tasks) closeTaskSet(tasks);
    tasks = null;
  }

  return { handle };
}

type WorkerScope = {
  document?: unknown;
  onmessage: ((event: MessageEvent<LandmarkWorkerCommand>) => void) | null;
  postMessage(message: LandmarkWorkerResult): void;
};

const workerScope = typeof self === "undefined" ? undefined : self as unknown as WorkerScope;
if (workerScope && workerScope.document === undefined && typeof workerScope.postMessage === "function") {
  const processor = createLandmarkWorkerProcessor({
    createTasks: (config) => createMediaPipeTasks(config),
    emit: (message) => workerScope.postMessage(message)
  });
  workerScope.onmessage = (event) => {
    void processor.handle(event.data);
  };
}
