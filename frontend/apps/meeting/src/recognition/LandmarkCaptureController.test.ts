import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import activeChunkFixture from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import { LandmarkCaptureController as LandmarkCaptureControllerUnderTest } from "./LandmarkCaptureController";
import {
  createLandmarkWorkerProcessor as createLandmarkWorkerProcessorUnderTest,
  createMediaPipeTasks as createMediaPipeTasksUnderTest
} from "./landmark.worker";
import { useLandmarkCapture } from "./useLandmarkCapture";

type WorkerCommand = Record<string, unknown> & { type: string };
type WorkerResult = Record<string, unknown> & { type: string };
type CaptureStatus =
  | "stopped"
  | "model-loading"
  | "camera-waiting"
  | "ready"
  | "tracking"
  | "no-hands"
  | "low-quality"
  | "unavailable"
  | "error";

type ClosableFrame = ImageBitmap & { close: ReturnType<typeof vi.fn> };

type WorkerLike = {
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerCommand, transfer?: Transferable[]): void;
  terminate(): void;
};

type Scheduler = {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
};

type WatchdogScheduler = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

type Controller = {
  readonly status: CaptureStatus;
  readonly streamId: string | null;
  start(video: HTMLVideoElement): string | null;
  stop(): void;
  restart(video: HTMLVideoElement): string | null;
  cameraOff(): void;
  dispose(): void;
};

type ControllerConstructor = new (options: {
  workerFactory(): WorkerLike;
  frameFactory(video: HTMLVideoElement): ImageBitmap | Promise<ImageBitmap>;
  scheduler: Scheduler;
  clock: { now(): number };
  uuidFactory(): string;
  assets: {
    wasmRootUrl: string;
    handModelUrl: string;
    poseModelUrl: string;
  };
  onStatus?(status: CaptureStatus): void;
  onGestureCandidate?(candidate: Array<{ timestampMs: number; features: number[] }>): void;
  watchdogScheduler?: WatchdogScheduler;
  initializationTimeoutMs?: number;
  processingTimeoutMs?: number;
}) => Controller;

type WorkerProcessor = {
  handle(command: WorkerCommand): Promise<void>;
};

type CreateWorkerProcessor = (options: {
  createTasks(config: unknown): Promise<{
    hand: { detectForVideo(frame: ImageBitmap, timestampMs: number): unknown; close(): void };
    pose: { detectForVideo(frame: ImageBitmap, timestampMs: number): unknown; close(): void };
  }>;
  emit(result: WorkerResult): void;
}) => WorkerProcessor;

type CreateMediaPipeTasks = (config: {
  wasmRootUrl: string;
  handModelUrl: string;
  poseModelUrl: string;
}, bindings: {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  HandLandmarker: { createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<unknown> };
  PoseLandmarker: { createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<unknown> };
}) => Promise<unknown>;

function controllerConstructorFor(_behavior: string): ControllerConstructor {
  return LandmarkCaptureControllerUnderTest as unknown as ControllerConstructor;
}

function workerFunctionsFor(behavior: string): {
  createLandmarkWorkerProcessor: CreateWorkerProcessor;
  createMediaPipeTasks: CreateMediaPipeTasks;
} {
  void behavior;
  return {
    createLandmarkWorkerProcessor: createLandmarkWorkerProcessorUnderTest as unknown as CreateWorkerProcessor,
    createMediaPipeTasks: createMediaPipeTasksUnderTest as unknown as CreateMediaPipeTasks
  } as {
    createLandmarkWorkerProcessor: CreateWorkerProcessor;
    createMediaPipeTasks: CreateMediaPipeTasks;
  };
}

class ManualScheduler implements Scheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly cancelled: number[] = [];

  request(callback: FrameRequestCallback): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  step(timestampMs: number): void {
    const entry = this.callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    const [handle, callback] = entry;
    this.callbacks.delete(handle);
    callback(timestampMs);
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

class ManualWatchdogScheduler implements WatchdogScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly cleared: number[] = [];

  set(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.delays.push(delayMs);
    return handle;
  }

  clear(handle: unknown): void {
    const numericHandle = handle as number;
    this.cleared.push(numericHandle);
    this.callbacks.delete(numericHandle);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No watchdog was scheduled");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<{ message: WorkerCommand; transfer: Transferable[] }> = [];
  readonly terminate = vi.fn();
  autoRespond = false;

  postMessage(message: WorkerCommand, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (this.autoRespond && message.type === "frame.process") {
      queueMicrotask(() => this.emit({
        type: "frame.result",
        requestId: message.requestId,
        timestampMs: message.timestampMs,
        result: {
          kind: "accepted",
          frameKind: "idle",
          features: activeChunkFixture.frames[0].features
        }
      }));
    }
  }

  emit(message: WorkerResult): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResult>);
  }

  fail(): void {
    this.onerror?.(new Event("error") as ErrorEvent);
  }
}

const readyVideo = {
  readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
  videoWidth: 640,
  videoHeight: 480
} as HTMLVideoElement;

const assets = {
  wasmRootUrl: "/assets/mediapipe/1.0.1/wasm",
  handModelUrl: "/assets/mediapipe/hand_landmarker/1/hand_landmarker.task",
  poseModelUrl: "/assets/mediapipe/pose_landmarker_lite/1/pose_landmarker_lite.task"
};

function fakeFrame(label: string): ClosableFrame {
  return { label, close: vi.fn() } as unknown as ClosableFrame;
}

async function flushCapture(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function controllerOptions(worker: FakeWorker, scheduler: ManualScheduler, now: { value: number }, overrides: Record<string, unknown> = {}) {
  return {
    workerFactory: () => worker,
    frameFactory: () => fakeFrame("frame"),
    scheduler,
    clock: { now: () => now.value },
    uuidFactory: () => "11111111-1111-4111-8111-111111111111",
    assets,
    watchdogScheduler: new ManualWatchdogScheduler(),
    ...overrides
  };
}

function processMessages(worker: FakeWorker): Array<{ message: WorkerCommand; transfer: Transferable[] }> {
  return worker.posted.filter((entry) => entry.message.type === "frame.process");
}

describe("LandmarkCaptureController", () => {
  it("forwards one completed 30-frame gesture candidate through the browser-local adapter", async () => {
    const LandmarkCaptureController = controllerConstructorFor("gesture candidate adapter");
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const now = { value: 40 };
    const onGestureCandidate = vi.fn();
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now, { onGestureCandidate }));

    controller.start(readyVideo);
    worker.emit({ type: "worker.ready" });
    scheduler.step(40);
    await flushCapture();
    const pending = processMessages(worker)[0].message;
    const candidate = Array.from({ length: 30 }, (_unused, index) => ({
      timestampMs: 40 + index * 40,
      features: [...activeChunkFixture.frames[0].features]
    }));
    worker.emit({
      type: "frame.result",
      requestId: pending.requestId,
      timestampMs: pending.timestampMs,
      result: { kind: "accepted", frameKind: "active", features: activeChunkFixture.frames[0].features },
      gestureCandidate: candidate
    });

    expect(onGestureCandidate).toHaveBeenCalledOnce();
    expect(onGestureCandidate).toHaveBeenCalledWith(candidate);
  });

  it("waits for model and video readiness and permits only one frame in flight", async () => {
    const LandmarkCaptureController = controllerConstructorFor("readiness and one-frame backpressure");
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    const frameFactory = vi.fn(() => fakeFrame("one"));
    const statuses: CaptureStatus[] = [];
    const video = { readyState: HTMLMediaElement.HAVE_METADATA, videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now, {
      frameFactory,
      onStatus: (status: CaptureStatus) => statuses.push(status)
    }));

    controller.start(video);
    expect(worker.posted[0].message).toEqual({ type: "worker.initialize", config: assets });
    expect(statuses).toEqual(["model-loading"]);

    worker.emit({ type: "worker.ready" });
    scheduler.step(0);
    await flushCapture();
    expect(frameFactory).not.toHaveBeenCalled();
    expect(statuses).toEqual(["model-loading", "camera-waiting"]);

    Object.assign(video, { readyState: HTMLMediaElement.HAVE_CURRENT_DATA, videoWidth: 640, videoHeight: 480 });
    now.value = 40;
    scheduler.step(40);
    await flushCapture();
    expect(frameFactory).toHaveBeenCalledOnce();
    expect(processMessages(worker)).toHaveLength(1);
    expect(processMessages(worker)[0].transfer).toEqual([processMessages(worker)[0].message.frame]);

    now.value = 80;
    scheduler.step(80);
    await flushCapture();
    expect(frameFactory).toHaveBeenCalledOnce();

    const pending = processMessages(worker)[0].message;
    worker.emit({
      type: "frame.result",
      requestId: pending.requestId,
      timestampMs: pending.timestampMs,
      result: { kind: "accepted", frameKind: "idle", features: activeChunkFixture.frames[0].features }
    });

    now.value = 120;
    scheduler.step(120);
    await flushCapture();
    expect(frameFactory).toHaveBeenCalledTimes(2);
    expect(processMessages(worker)).toHaveLength(2);
    expect(statuses).toContain("no-hands");
  });

  it("samples within the 20-30 FPS acceptance range without sending rolling frames", async () => {
    const LandmarkCaptureController = controllerConstructorFor("25 FPS scheduling");
    const worker = new FakeWorker();
    worker.autoRespond = true;
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    const frameFactory = vi.fn(() => fakeFrame(`frame-${now.value}`));
    const statuses: CaptureStatus[] = [];
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now, {
      frameFactory,
      onStatus: (status: CaptureStatus) => statuses.push(status)
    }));

    controller.start(readyVideo);
    worker.emit({ type: "worker.ready" });
    for (let timestampMs = 0; timestampMs <= 1000; timestampMs += 10) {
      now.value = timestampMs;
      scheduler.step(timestampMs);
      await flushCapture();
    }

    expect(processMessages(worker).length).toBeGreaterThanOrEqual(20);
    expect(processMessages(worker).length).toBeLessThanOrEqual(30);
    expect(frameFactory).toHaveBeenCalledTimes(processMessages(worker).length);
    expect(statuses.filter((status) => status === "no-hands")).toHaveLength(1);
    controller.stop();
  });

  it("releases a frame that resolves after stop and tears resources down idempotently", async () => {
    const LandmarkCaptureController = controllerConstructorFor("stop cleanup");
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    let resolveFrame!: (frame: ImageBitmap) => void;
    const framePromise = new Promise<ImageBitmap>((resolve) => { resolveFrame = resolve; });
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now, {
      frameFactory: () => framePromise
    }));

    controller.start(readyVideo);
    worker.emit({ type: "worker.ready" });
    scheduler.step(0);
    controller.stop();

    const frame = fakeFrame("late");
    resolveFrame(frame);
    await flushCapture();
    controller.stop();

    expect(frame.close).toHaveBeenCalledOnce();
    expect(processMessages(worker)).toHaveLength(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount).toBe(0);
    expect(controller.status).toBe("stopped");
  });

  it("uses a new stream on restart and terminates the replaced worker", () => {
    const LandmarkCaptureController = controllerConstructorFor("stream replacement");
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    let workerIndex = 0;
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    const streamIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];
    const controller = new LandmarkCaptureController({
      ...controllerOptions(workers[0], scheduler, now),
      workerFactory: () => workers[workerIndex++]!,
      uuidFactory: () => streamIds.shift()!
    });

    const firstStreamId = controller.start(readyVideo);
    const secondStreamId = controller.restart(readyVideo);

    expect(firstStreamId).toBe("11111111-1111-4111-8111-111111111111");
    expect(secondStreamId).toBe("22222222-2222-4222-8222-222222222222");
    expect(controller.streamId).toBe(secondStreamId);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(secondWorker.posted[0].message).toEqual({ type: "worker.initialize", config: assets });
  });

  it("keeps the replacement stream guarded when an old frame creation rejects late", async () => {
    const LandmarkCaptureController = controllerConstructorFor("late frame rejection after stream replacement");
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    let workerIndex = 0;
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    let rejectFirstFrame!: (reason: Error) => void;
    let resolveSecondFrame!: (frame: ImageBitmap) => void;
    const firstFrame = new Promise<ImageBitmap>((_resolve, reject) => { rejectFirstFrame = reject; });
    const secondFrame = new Promise<ImageBitmap>((resolve) => { resolveSecondFrame = resolve; });
    const frameFactory = vi.fn()
      .mockImplementationOnce(() => firstFrame)
      .mockImplementationOnce(() => secondFrame)
      .mockImplementation(() => Promise.resolve(fakeFrame("unexpected")));
    const controller = new LandmarkCaptureController({
      ...controllerOptions(firstWorker, scheduler, now),
      workerFactory: () => workers[workerIndex++]!,
      frameFactory
    });

    controller.start(readyVideo);
    firstWorker.emit({ type: "worker.ready" });
    scheduler.step(0);
    await flushCapture();

    controller.restart(readyVideo);
    secondWorker.emit({ type: "worker.ready" });
    now.value = 40;
    scheduler.step(40);
    await flushCapture();

    rejectFirstFrame(new Error("old frame creation failed"));
    await flushCapture();
    now.value = 80;
    scheduler.step(80);
    await flushCapture();

    expect(frameFactory).toHaveBeenCalledTimes(2);
    expect(processMessages(firstWorker)).toHaveLength(0);

    resolveSecondFrame(fakeFrame("replacement"));
    await flushCapture();
    expect(processMessages(secondWorker)).toHaveLength(1);
    controller.stop();
  });

  it("reports browser worker startup failures as unavailable without returning a stream id", () => {
    const LandmarkCaptureController = controllerConstructorFor("typed worker startup failure");
    const scheduler = new ManualScheduler();
    const statuses: CaptureStatus[] = [];
    const constructionFailure = new LandmarkCaptureController({
      ...controllerOptions(new FakeWorker(), scheduler, { value: 0 }),
      workerFactory: () => { throw new Error("worker construction details"); },
      onStatus: (status: CaptureStatus) => statuses.push(status)
    });

    expect(() => constructionFailure.start(readyVideo)).not.toThrow();
    expect(constructionFailure.start(readyVideo)).toBeNull();
    expect(constructionFailure.status).toBe("unavailable");
    expect(constructionFailure.streamId).toBeNull();

    const initializeFailure = new FakeWorker();
    initializeFailure.postMessage = vi.fn(() => { throw new Error("initialization send details"); });
    const sendFailure = new LandmarkCaptureController(controllerOptions(
      initializeFailure,
      new ManualScheduler(),
      { value: 0 }
    ));

    expect(sendFailure.start(readyVideo)).toBeNull();
    expect(sendFailure.status).toBe("unavailable");
    expect(sendFailure.streamId).toBeNull();
    expect(initializeFailure.terminate).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["unavailable"]);
  });

  it("bounds worker initialization and fully tears down when ready never arrives", () => {
    const LandmarkCaptureController = controllerConstructorFor("worker initialization watchdog");
    const worker = new FakeWorker();
    const animationScheduler = new ManualScheduler();
    const watchdogScheduler = new ManualWatchdogScheduler();
    const statuses: CaptureStatus[] = [];
    const controller = new LandmarkCaptureController(controllerOptions(worker, animationScheduler, { value: 0 }, {
      watchdogScheduler,
      initializationTimeoutMs: 1_500,
      processingTimeoutMs: 250,
      onStatus: (status: CaptureStatus) => statuses.push(status)
    }));

    expect(controller.start(readyVideo)).toBe("11111111-1111-4111-8111-111111111111");
    expect(watchdogScheduler.delays).toEqual([1_500]);
    expect(watchdogScheduler.pendingCount).toBe(1);

    watchdogScheduler.runNext();

    expect(controller.status).toBe("unavailable");
    expect(controller.streamId).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(animationScheduler.pendingCount).toBe(0);
    expect(watchdogScheduler.pendingCount).toBe(0);
    expect(statuses).toEqual(["model-loading", "unavailable"]);

    worker.emit({ type: "worker.ready" });
    expect(controller.status).toBe("unavailable");
  });

  it("bounds a never-settling frame request and clears every watchdog on teardown", async () => {
    const LandmarkCaptureController = controllerConstructorFor("worker frame-processing watchdog");
    const worker = new FakeWorker();
    const animationScheduler = new ManualScheduler();
    const watchdogScheduler = new ManualWatchdogScheduler();
    const frame = fakeFrame("never-settles");
    const controller = new LandmarkCaptureController(controllerOptions(worker, animationScheduler, { value: 0 }, {
      watchdogScheduler,
      initializationTimeoutMs: 1_500,
      processingTimeoutMs: 250,
      frameFactory: () => frame
    }));

    controller.start(readyVideo);
    expect(watchdogScheduler.pendingCount).toBe(1);
    worker.emit({ type: "worker.ready" });
    expect(watchdogScheduler.pendingCount).toBe(0);

    animationScheduler.step(0);
    await flushCapture();
    expect(processMessages(worker)).toHaveLength(1);
    expect(watchdogScheduler.delays).toEqual([1_500, 250]);
    expect(watchdogScheduler.pendingCount).toBe(1);

    watchdogScheduler.runNext();

    expect(controller.status).toBe("error");
    expect(controller.streamId).toBeNull();
    expect(frame.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(animationScheduler.pendingCount).toBe(0);
    expect(watchdogScheduler.pendingCount).toBe(0);
  });

  it("closes an in-flight frame and enters error state on worker failure or unmount", async () => {
    const LandmarkCaptureController = controllerConstructorFor("worker-error and unmount cleanup");
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    const frame = fakeFrame("in-flight");
    const statuses: CaptureStatus[] = [];
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now, {
      frameFactory: () => frame,
      onStatus: (status: CaptureStatus) => statuses.push(status)
    }));

    controller.start(readyVideo);
    worker.emit({ type: "worker.ready" });
    scheduler.step(0);
    await flushCapture();
    worker.fail();
    controller.dispose();

    expect(frame.close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("error");
    expect(scheduler.pendingCount).toBe(0);
  });

  it("surfaces typed worker processing failures as error and stops capture", async () => {
    const LandmarkCaptureController = controllerConstructorFor("typed worker processing failure");
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const now = { value: 0 };
    const controller = new LandmarkCaptureController(controllerOptions(worker, scheduler, now));

    controller.start(readyVideo);
    worker.emit({ type: "worker.ready" });
    scheduler.step(0);
    await flushCapture();
    const pending = processMessages(worker)[0].message;

    worker.emit({
      type: "worker.error",
      code: "PROCESSING_FAILED",
      message: "Vision frame processing failed.",
      requestId: pending.requestId,
      fatal: false
    });

    expect(controller.status).toBe("error");
    expect(controller.streamId).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("tears down active capture when the camera turns off or the owner unmounts", async () => {
    const LandmarkCaptureController = controllerConstructorFor("camera-off and unmount cleanup");
    const firstWorker = new FakeWorker();
    const firstScheduler = new ManualScheduler();
    const firstNow = { value: 0 };
    const firstFrame = fakeFrame("camera-off");
    const cameraController = new LandmarkCaptureController(controllerOptions(firstWorker, firstScheduler, firstNow, {
      frameFactory: () => firstFrame
    }));
    cameraController.start(readyVideo);
    firstWorker.emit({ type: "worker.ready" });
    firstScheduler.step(0);
    await flushCapture();

    cameraController.cameraOff();

    expect(firstFrame.close).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(firstScheduler.pendingCount).toBe(0);

    const secondWorker = new FakeWorker();
    const secondScheduler = new ManualScheduler();
    const secondController = new LandmarkCaptureController(controllerOptions(secondWorker, secondScheduler, { value: 0 }));
    secondController.start(readyVideo);
    secondController.dispose();

    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    expect(secondScheduler.pendingCount).toBe(0);
  });
});

describe("useLandmarkCapture", () => {
  it("does not expose a stream id when worker initialization cannot start", () => {
    const worker = new FakeWorker();
    worker.postMessage = vi.fn(() => { throw new Error("initialization send details"); });
    const { result } = renderHook(() => useLandmarkCapture({
      workerFactory: () => worker,
      frameFactory: () => fakeFrame("unused"),
      scheduler: new ManualScheduler(),
      clock: { now: () => 0 },
      uuidFactory: () => "11111111-1111-4111-8111-111111111111",
      assets,
    }));
    let streamId: string | null = "not-started";

    act(() => {
      streamId = result.current.start(readyVideo);
    });

    expect(streamId).toBeNull();
    expect(result.current.status).toBe("unavailable");
    expect(result.current.streamId).toBeNull();
  });
});

function landmarkFromFeatureGroup(features: number[], offset: number) {
  return {
    x: 0.5 + features[offset] * 0.5,
    y: 0.5 + features[offset + 1] * 0.5,
    z: 0.1 + features[offset + 2] * 0.5,
    visibility: features[offset + 3]
  };
}

function mediaPipeResults() {
  const features = activeChunkFixture.frames[0].features;
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (let index = 11; index <= 24; index += 1) {
    pose[index] = landmarkFromFeatureGroup(features, 168 + (index - 11) * 4);
  }

  return {
    hand: {
      landmarks: [
        Array.from({ length: 21 }, (_, index) => ({
          ...landmarkFromFeatureGroup(features, 84 + index * 4),
          visibility: 0
        })),
        Array.from({ length: 21 }, (_, index) => ({
          ...landmarkFromFeatureGroup(features, index * 4),
          visibility: 0
        }))
      ],
      handedness: [
        [{ categoryName: "Left", score: 0.98, index: 0, displayName: "Left" }],
        [{ categoryName: "Right", score: 0.99, index: 1, displayName: "Right" }]
      ],
      handednesses: [
        [{ categoryName: "Left", score: 0.98, index: 0, displayName: "Left" }],
        [{ categoryName: "Right", score: 0.99, index: 1, displayName: "Right" }]
      ],
      worldLandmarks: []
    },
    pose: { landmarks: [pose], worldLandmarks: [] }
  };
}

describe("landmark worker", () => {
  it("initializes reusable MediaPipe tasks in VIDEO mode with pinned asset locations", async () => {
    const { createMediaPipeTasks } = workerFunctionsFor("VIDEO task initialization");
    const fileset = { id: "wasm" };
    const hand = { close: vi.fn() };
    const pose = { close: vi.fn() };
    const bindings = {
      FilesetResolver: { forVisionTasks: vi.fn(async () => fileset) },
      HandLandmarker: { createFromOptions: vi.fn(async () => hand) },
      PoseLandmarker: { createFromOptions: vi.fn(async () => pose) }
    };

    const tasks = await createMediaPipeTasks(assets, bindings);

    expect(bindings.FilesetResolver.forVisionTasks).toHaveBeenCalledWith(assets.wasmRootUrl);
    expect(bindings.HandLandmarker.createFromOptions).toHaveBeenCalledWith(fileset, expect.objectContaining({
      baseOptions: { modelAssetPath: assets.handModelUrl },
      runningMode: "VIDEO",
      numHands: 2
    }));
    expect(bindings.PoseLandmarker.createFromOptions).toHaveBeenCalledWith(fileset, expect.objectContaining({
      baseOptions: { modelAssetPath: assets.poseModelUrl },
      runningMode: "VIDEO",
      numPoses: 1,
      outputSegmentationMasks: false
    }));
    expect(tasks).toEqual({ hand, pose });
  });

  it("uses strictly increasing VIDEO timestamps, normalizes results, and closes every frame", async () => {
    const { createLandmarkWorkerProcessor } = workerFunctionsFor("VIDEO timestamp processing");
    const results = mediaPipeResults();
    const hand = {
      detectForVideo: vi.fn((_frame: ImageBitmap, _timestampMs: number) => results.hand),
      close: vi.fn()
    };
    const pose = {
      detectForVideo: vi.fn((_frame: ImageBitmap, _timestampMs: number) => results.pose),
      close: vi.fn()
    };
    const createTasks = vi.fn(async () => ({ hand, pose }));
    const emitted: WorkerResult[] = [];
    const processor = createLandmarkWorkerProcessor({ createTasks, emit: (message) => emitted.push(message) });

    await processor.handle({ type: "worker.initialize", config: assets });
    const first = fakeFrame("RAW_PIXEL_SENTINEL_A");
    const second = fakeFrame("RAW_PIXEL_SENTINEL_B");
    await processor.handle({ type: "frame.process", requestId: 0, timestampMs: 10, frame: first });
    await processor.handle({ type: "frame.process", requestId: 1, timestampMs: 50, frame: second });

    expect(createTasks).toHaveBeenCalledOnce();
    expect(hand.detectForVideo.mock.calls.map((call) => call[1])).toEqual([10, 50]);
    expect(pose.detectForVideo.mock.calls.map((call) => call[1])).toEqual([10, 50]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    const frameResults = emitted.filter((message) => message.type === "frame.result");
    expect(frameResults).toHaveLength(2);
    expect(frameResults[0]).toMatchObject({
      result: {
        kind: "accepted",
        frameKind: "active",
        features: activeChunkFixture.frames[0].features
      },
      browserLocal: {
        trackingQuality: {
          state: "ready",
          personDetected: true,
          upperBodyVisible: true,
          leftHandVisible: true,
          rightHandVisible: true,
          handsInsideFrame: true
        },
        calibration: { state: "collecting", stableFrames: 1, requiredStableFrames: 8 },
        gesturePhase: "idle"
      }
    });
    expect(JSON.stringify(emitted)).not.toContain("RAW_PIXEL_SENTINEL");
    expect(JSON.stringify(emitted)).not.toContain("landmarks");

    const duplicateTimestamp = fakeFrame("duplicate");
    await processor.handle({ type: "frame.process", requestId: 2, timestampMs: 50, frame: duplicateTimestamp });
    expect(duplicateTimestamp.close).toHaveBeenCalledOnce();
    expect(emitted.at(-1)).toMatchObject({
      type: "worker.error",
      code: "NON_MONOTONIC_TIMESTAMP",
      requestId: 2
    });

    await processor.handle({ type: "worker.dispose" });
    expect(hand.close).toHaveBeenCalledOnce();
    expect(pose.close).toHaveBeenCalledOnce();
  });

  it("closes frames on inference failure and emits only a sanitized typed error", async () => {
    const { createLandmarkWorkerProcessor } = workerFunctionsFor("sanitized failure cleanup");
    const hand = {
      detectForVideo: vi.fn(() => { throw new Error("RAW_PIXEL_SENTINEL should not escape"); }),
      close: vi.fn()
    };
    const pose = { detectForVideo: vi.fn(), close: vi.fn() };
    const emitted: WorkerResult[] = [];
    const processor = createLandmarkWorkerProcessor({
      createTasks: async () => ({ hand, pose }),
      emit: (message) => emitted.push(message)
    });
    await processor.handle({ type: "worker.initialize", config: assets });

    const frame = fakeFrame("RAW_PIXEL_SENTINEL");
    await processor.handle({ type: "frame.process", requestId: 7, timestampMs: 100, frame });

    expect(frame.close).toHaveBeenCalledOnce();
    expect(emitted.at(-1)).toEqual({
      type: "worker.error",
      code: "PROCESSING_FAILED",
      message: "Vision frame processing failed.",
      requestId: 7,
      fatal: false
    });
    expect(JSON.stringify(emitted.at(-1))).not.toContain("RAW_PIXEL_SENTINEL");
  });

  it("reports model initialization failure as unavailable without exposing exception details", async () => {
    const { createLandmarkWorkerProcessor } = workerFunctionsFor("typed model unavailability");
    const emitted: WorkerResult[] = [];
    const processor = createLandmarkWorkerProcessor({
      createTasks: async () => { throw new Error("secret model location"); },
      emit: (message) => emitted.push(message)
    });

    await processor.handle({ type: "worker.initialize", config: assets });

    expect(emitted).toEqual([{
      type: "worker.error",
      code: "MODEL_UNAVAILABLE",
      message: "Vision model is unavailable.",
      fatal: true
    }]);
    expect(JSON.stringify(emitted)).not.toContain("secret model location");
  });
});
