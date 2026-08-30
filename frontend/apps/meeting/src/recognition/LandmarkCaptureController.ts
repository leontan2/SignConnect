import {
  CAPTURE_INTERVAL_MS,
  type BrowserLocalVisionFrame,
  type LandmarkCaptureStatus,
  type VisionAssetLocations
} from "./contracts";
import type { GestureCandidateFrame } from "./trackingQuality";
import type {
  LandmarkWorkerCommand,
  LandmarkWorkerLike,
  LandmarkWorkerResult
} from "./workerProtocol";

export interface AnimationScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface MonotonicClock {
  now(): number;
}

export interface WatchdogScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface LandmarkCaptureControllerOptions {
  workerFactory?: () => LandmarkWorkerLike;
  frameFactory?: (video: HTMLVideoElement) => ImageBitmap | Promise<ImageBitmap>;
  scheduler?: AnimationScheduler;
  clock?: MonotonicClock;
  uuidFactory?: () => string;
  assets?: VisionAssetLocations;
  onStatus?: (status: LandmarkCaptureStatus) => void;
  onBrowserLocalFrame?: (frame: BrowserLocalVisionFrame | null) => void;
  onGestureCandidate?: (candidate: GestureCandidateFrame[]) => void;
  watchdogScheduler?: WatchdogScheduler;
  initializationTimeoutMs?: number;
  processingTimeoutMs?: number;
}

const DEFAULT_WASM_ROOT_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const DEFAULT_HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const DEFAULT_POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export const DEFAULT_VISION_ASSET_LOCATIONS: VisionAssetLocations = {
  wasmRootUrl: process.env.MEDIAPIPE_WASM_ROOT_URL || DEFAULT_WASM_ROOT_URL,
  handModelUrl: process.env.MEDIAPIPE_HAND_MODEL_URL || DEFAULT_HAND_MODEL_URL,
  poseModelUrl: process.env.MEDIAPIPE_POSE_MODEL_URL || DEFAULT_POSE_MODEL_URL
};

const defaultScheduler: AnimationScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle)
};

const defaultWatchdogScheduler: WatchdogScheduler = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle as number)
};

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESSING_TIMEOUT_MS = 2_000;

type NativeWorkerConstructor = new (scriptURL: string | URL, options?: WorkerOptions) => Worker;

class RevocableWorkerAdapter implements LandmarkWorkerLike {
  private readonly worker: Worker;
  private readonly objectUrl: string;
  private messageHandler: LandmarkWorkerLike["onmessage"] = null;
  private errorHandler: LandmarkWorkerLike["onerror"] = null;
  private revoked = false;

  constructor(worker: Worker, objectUrl: string) {
    this.worker = worker;
    this.objectUrl = objectUrl;
    worker.onmessage = (event) => {
      this.revokeObjectUrl();
      this.messageHandler?.(event as MessageEvent<LandmarkWorkerResult>);
    };
    worker.onerror = (event) => {
      this.revokeObjectUrl();
      this.errorHandler?.(event);
    };
  }

  get onmessage(): LandmarkWorkerLike["onmessage"] {
    return this.messageHandler;
  }

  set onmessage(handler: LandmarkWorkerLike["onmessage"]) {
    this.messageHandler = handler;
  }

  get onerror(): LandmarkWorkerLike["onerror"] {
    return this.errorHandler;
  }

  set onerror(handler: LandmarkWorkerLike["onerror"]) {
    this.errorHandler = handler;
  }

  postMessage(message: LandmarkWorkerCommand, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  terminate(): void {
    this.revokeObjectUrl();
    this.worker.terminate();
  }

  private revokeObjectUrl(): void {
    if (this.revoked) return;
    this.revoked = true;
    URL.revokeObjectURL(this.objectUrl);
  }
}

function createClassicWorkerBootstrap(workerUrl: URL, pageOrigin: string): string {
  const workerBaseUrl = new URL(".", workerUrl).href;
  return `
const workerEntryUrl = ${JSON.stringify(workerUrl.href)};
const workerBaseUrl = ${JSON.stringify(workerBaseUrl)};
const pageOrigin = ${JSON.stringify(pageOrigin)};
const nativeImportScripts = self.importScripts.bind(self);

self.importScripts = (...sources) => nativeImportScripts(...sources.map((source) => {
  const requested = new URL(String(source), self.location.href);
  if (requested.origin !== pageOrigin) return requested.href;

  const fileName = requested.pathname.slice(requested.pathname.lastIndexOf("/") + 1);
  return new URL(fileName + requested.search + requested.hash, workerBaseUrl).href;
}));

nativeImportScripts(workerEntryUrl);
`;
}

function constructCrossOriginAwareWorker(
  NativeWorker: NativeWorkerConstructor,
  scriptURL: string | URL,
  options?: WorkerOptions
): Worker | LandmarkWorkerLike {
  const workerUrl = new URL(String(scriptURL), document.baseURI);
  if (workerUrl.origin === window.location.origin) {
    return new NativeWorker(workerUrl, options);
  }

  const bootstrap = createClassicWorkerBootstrap(workerUrl, window.location.origin);
  const objectUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
  const classicOptions = options ? { ...options } : {};
  delete classicOptions.type;
  try {
    return new RevocableWorkerAdapter(new NativeWorker(objectUrl, classicOptions), objectUrl);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function defaultWorkerFactory(): LandmarkWorkerLike {
  const workerGlobal = globalThis as typeof globalThis & { Worker: NativeWorkerConstructor };
  const NativeWorker = workerGlobal.Worker;
  // Webpack only emits a worker entry for the literal `new Worker(new URL())`
  // form. Swap the constructor for this synchronous expression so we can see
  // the emitted URL and bootstrap it from a same-origin Blob when a federated
  // remote serves the worker from another origin.
  workerGlobal.Worker = new Proxy(NativeWorker, {
    construct(_target, args: [string | URL, WorkerOptions?]) {
      return constructCrossOriginAwareWorker(NativeWorker, args[0], args[1]);
    }
  });
  try {
    return new Worker(new URL("./landmark.worker.ts", import.meta.url), { type: "module" });
  } finally {
    workerGlobal.Worker = NativeWorker;
  }
}

function videoIsReady(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && video.videoWidth > 0
    && video.videoHeight > 0;
}

function releaseFrame(frame: ImageBitmap | null): void {
  if (!frame) return;
  try {
    frame.close();
  } catch {
    // The worker may already own a detached ImageBitmap.
  }
}

export class LandmarkCaptureController {
  private readonly workerFactory: () => LandmarkWorkerLike;
  private readonly frameFactory: (video: HTMLVideoElement) => ImageBitmap | Promise<ImageBitmap>;
  private readonly scheduler: AnimationScheduler;
  private readonly clock: MonotonicClock;
  private readonly uuidFactory: () => string;
  private readonly assets: VisionAssetLocations;
  private readonly onStatus?: (status: LandmarkCaptureStatus) => void;
  private readonly onBrowserLocalFrame?: (frame: BrowserLocalVisionFrame | null) => void;
  private readonly onGestureCandidate?: (candidate: GestureCandidateFrame[]) => void;
  private readonly watchdogScheduler: WatchdogScheduler;
  private readonly initializationTimeoutMs: number;
  private readonly processingTimeoutMs: number;

  private worker: LandmarkWorkerLike | null = null;
  private video: HTMLVideoElement | null = null;
  private animationHandle: number | null = null;
  private active = false;
  private capturePaused = false;
  private modelReady = false;
  private creatingFrame = false;
  private inFlightRequestId: number | null = null;
  private inFlightFrame: ImageBitmap | null = null;
  private nextRequestId = 0;
  private lastCaptureTimestampMs = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private statusValue: LandmarkCaptureStatus = "stopped";
  private streamIdValue: string | null = null;
  private initializationWatchdogHandle: unknown = null;
  private processingWatchdogHandle: unknown = null;

  constructor(options: LandmarkCaptureControllerOptions) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.frameFactory = options.frameFactory ?? ((video) => createImageBitmap(video));
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.clock = options.clock ?? performance;
    this.uuidFactory = options.uuidFactory ?? (() => crypto.randomUUID());
    this.assets = options.assets ?? DEFAULT_VISION_ASSET_LOCATIONS;
    this.onStatus = options.onStatus;
    this.onBrowserLocalFrame = options.onBrowserLocalFrame;
    this.onGestureCandidate = options.onGestureCandidate;
    this.watchdogScheduler = options.watchdogScheduler ?? defaultWatchdogScheduler;
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    this.processingTimeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;

    if (!Number.isFinite(this.initializationTimeoutMs) || this.initializationTimeoutMs <= 0) {
      throw new RangeError("initializationTimeoutMs must be a positive finite number.");
    }
    if (!Number.isFinite(this.processingTimeoutMs) || this.processingTimeoutMs <= 0) {
      throw new RangeError("processingTimeoutMs must be a positive finite number.");
    }
  }

  get status(): LandmarkCaptureStatus {
    return this.statusValue;
  }

  get streamId(): string | null {
    return this.streamIdValue;
  }

  start(video: HTMLVideoElement, capturePaused = false): string | null {
    if (this.active || this.worker) this.teardown("stopped");

    let streamId: string;
    let worker: LandmarkWorkerLike;
    try {
      streamId = this.uuidFactory();
      worker = this.workerFactory();
    } catch {
      this.setStatus("unavailable");
      return null;
    }
    this.generation += 1;
    this.active = true;
    this.capturePaused = capturePaused;
    this.modelReady = false;
    this.creatingFrame = false;
    this.inFlightRequestId = null;
    this.inFlightFrame = null;
    this.nextRequestId = 0;
    this.lastCaptureTimestampMs = Number.NEGATIVE_INFINITY;
    this.streamIdValue = streamId;
    this.video = video;
    this.worker = worker;

    worker.onmessage = (event) => {
      if (this.worker === worker) this.handleWorkerResult(event.data);
    };
    worker.onerror = () => {
      if (this.worker === worker) this.teardown("error");
    };

    this.setStatus("model-loading");
    const initialize: LandmarkWorkerCommand = { type: "worker.initialize", config: this.assets };
    this.armInitializationWatchdog(this.generation);
    try {
      worker.postMessage(initialize);
    } catch {
      this.teardown("unavailable");
      return null;
    }
    this.scheduleNextFrame();
    return streamId;
  }

  stop(): void {
    if (!this.active && !this.worker) return;
    this.teardown("stopped");
  }

  restart(video: HTMLVideoElement): string | null {
    this.stop();
    return this.start(video);
  }

  resumeCapture(): void {
    if (!this.active || !this.streamIdValue || !this.capturePaused) return;
    this.capturePaused = false;
    this.lastCaptureTimestampMs = Number.NEGATIVE_INFINITY;
  }

  cameraOff(): void {
    this.stop();
  }

  dispose(): void {
    this.stop();
  }

  private scheduleNextFrame(): void {
    if (!this.active || this.animationHandle !== null) return;
    this.animationHandle = this.scheduler.request(() => {
      this.animationHandle = null;
      void this.captureTick();
      this.scheduleNextFrame();
    });
  }

  private async captureTick(): Promise<void> {
    const video = this.video;
    const worker = this.worker;
    if (!this.active || !video || !worker || !this.modelReady) return;
    if (!videoIsReady(video)) {
      this.setStatus("camera-waiting");
      return;
    }
    if (this.statusValue === "camera-waiting") this.setStatus("ready");
    if (this.capturePaused) return;
    if (this.creatingFrame || this.inFlightRequestId !== null) return;

    const timestampMs = this.clock.now();
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return;
    if (timestampMs - this.lastCaptureTimestampMs < CAPTURE_INTERVAL_MS) return;

    this.creatingFrame = true;
    const generation = this.generation;
    let frame: ImageBitmap;
    try {
      frame = await this.frameFactory(video);
    } catch {
      if (generation === this.generation) {
        this.creatingFrame = false;
        if (this.active) this.teardown("error");
      }
      return;
    }

    if (generation !== this.generation || !this.active || this.worker !== worker) {
      releaseFrame(frame);
      return;
    }

    this.creatingFrame = false;
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.lastCaptureTimestampMs = timestampMs;
    this.inFlightRequestId = requestId;
    this.inFlightFrame = frame;
    const command: LandmarkWorkerCommand = {
      type: "frame.process",
      requestId,
      timestampMs,
      frame
    };

    try {
      this.armProcessingWatchdog(generation, requestId);
      worker.postMessage(command, [frame]);
    } catch {
      releaseFrame(frame);
      this.inFlightFrame = null;
      this.inFlightRequestId = null;
      this.teardown("error");
    }
  }

  private handleWorkerResult(message: LandmarkWorkerResult): void {
    if (!this.active) return;
    if (message.type === "worker.ready") {
      this.clearInitializationWatchdog();
      this.modelReady = true;
      this.setStatus(this.video && videoIsReady(this.video) ? "ready" : "camera-waiting");
      return;
    }

    if (message.type === "worker.error") {
      if (message.requestId !== undefined && message.requestId === this.inFlightRequestId) {
        this.clearProcessingWatchdog();
        this.inFlightRequestId = null;
        this.inFlightFrame = null;
      }
      this.teardown(message.code === "MODEL_UNAVAILABLE" ? "unavailable" : "error");
      return;
    }

    if (message.requestId !== this.inFlightRequestId) return;
    this.clearProcessingWatchdog();
    this.inFlightRequestId = null;
    // The worker owns and closes successfully transferred frames.
    this.inFlightFrame = null;

    if (message.browserLocal) this.onBrowserLocalFrame?.(message.browserLocal);
    if (message.gestureCandidate) this.onGestureCandidate?.(message.gestureCandidate);
    if (!this.active) return;

    if (message.result.kind === "rejected") {
      this.setStatus("low-quality");
      return;
    }

    this.setStatus(message.result.frameKind === "idle" ? "no-hands" : "tracking");
  }

  private teardown(finalStatus: LandmarkCaptureStatus): void {
    this.active = false;
    this.capturePaused = false;
    this.modelReady = false;
    this.generation += 1;
    this.clearInitializationWatchdog();
    this.clearProcessingWatchdog();
    if (this.animationHandle !== null) {
      this.scheduler.cancel(this.animationHandle);
      this.animationHandle = null;
    }

    releaseFrame(this.inFlightFrame);
    this.inFlightFrame = null;
    this.inFlightRequestId = null;
    this.creatingFrame = false;
    this.video = null;
    this.streamIdValue = null;
    this.onBrowserLocalFrame?.(null);

    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    this.setStatus(finalStatus);
  }

  private armInitializationWatchdog(generation: number): void {
    this.clearInitializationWatchdog();
    const handle = this.watchdogScheduler.set(() => {
      if (this.initializationWatchdogHandle !== handle) return;
      this.initializationWatchdogHandle = null;
      if (this.active && this.generation === generation && !this.modelReady) {
        this.teardown("unavailable");
      }
    }, this.initializationTimeoutMs);
    this.initializationWatchdogHandle = handle;
  }

  private armProcessingWatchdog(generation: number, requestId: number): void {
    this.clearProcessingWatchdog();
    const handle = this.watchdogScheduler.set(() => {
      if (this.processingWatchdogHandle !== handle) return;
      this.processingWatchdogHandle = null;
      if (this.active && this.generation === generation && this.inFlightRequestId === requestId) {
        this.teardown("error");
      }
    }, this.processingTimeoutMs);
    this.processingWatchdogHandle = handle;
  }

  private clearInitializationWatchdog(): void {
    if (this.initializationWatchdogHandle === null) return;
    this.watchdogScheduler.clear(this.initializationWatchdogHandle);
    this.initializationWatchdogHandle = null;
  }

  private clearProcessingWatchdog(): void {
    if (this.processingWatchdogHandle === null) return;
    this.watchdogScheduler.clear(this.processingWatchdogHandle);
    this.processingWatchdogHandle = null;
  }

  private setStatus(status: LandmarkCaptureStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.onStatus?.(status);
  }
}
