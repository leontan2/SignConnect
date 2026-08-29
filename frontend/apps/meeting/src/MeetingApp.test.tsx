import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import activeChunkFixture from "../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import captionFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import readyFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-ready.valid.json";
import unavailableFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-unavailable.valid.json";
import unknownFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-unknown.valid.json";
import MeetingApp, * as meetingModule from "./MeetingApp";

const meeting = {
  id: captionFixture.meetingId,
  title: "Accessible team sync",
  status: "READY",
  createdAt: "2026-01-01T00:00:00Z"
} as const;

type SocketHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent<string>) => void) | null;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: SocketHandler = null;
  onclose: SocketHandler = null;
  onerror: SocketHandler = null;
  onmessage: MessageHandler = null;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  failClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  message(value: unknown): void {
    this.messageRaw(JSON.stringify(value));
  }

  messageRaw(value: string): void {
    this.onmessage?.(new MessageEvent("message", { data: value }));
  }

  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
  }
}

type WorkerResult = Record<string, unknown> & { type: string };

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<Record<string, unknown>> = [];
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  emit(message: WorkerResult): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResult>);
  }
}

class FakeMediaTrack {
  readonly stop = vi.fn();
  private readonly endedListeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "ended") this.endedListeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === "ended") this.endedListeners.delete(listener);
  }

  end(): void {
    const event = new Event("ended");
    [...this.endedListeners].forEach((listener) => {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    });
  }

  get endedListenerCount(): number {
    return this.endedListeners.size;
  }
}

class ManualScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly cancelled: number[] = [];

  request(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  step(timestampMs: number): void {
    const entry = this.callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error("No capture frame was scheduled");
    this.callbacks.delete(entry[0]);
    entry[1](timestampMs);
  }
}

class ManualRetryScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];

  set(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.delays.push(delayMs);
    this.callbacks.set(handle, callback);
    return handle;
  }

  clear(handle: number): void {
    this.callbacks.delete(handle);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No realtime retry was scheduled");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

type MeetingAppFactory = (options?: Record<string, unknown>) => React.ComponentType;

type Harness = {
  user: ReturnType<typeof userEvent.setup>;
  captureScheduler: ManualScheduler;
  retryScheduler: ManualRetryScheduler;
  clock: { value: number };
  track: FakeMediaTrack;
  unmount(): void;
  video: HTMLVideoElement;
};

function makeHarness(): Harness {
  const captureScheduler = new ManualScheduler();
  const retryScheduler = new ManualRetryScheduler();
  const clock = { value: 0 };
  const streamIds = [
    "11111111-1111-4111-8111-111111111111",
    "33333333-3333-4333-8333-333333333333"
  ];
  const track = new FakeMediaTrack();
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia }
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => meeting
  })));
  vi.stubGlobal("WebSocket", FakeSocket);

  const createMeetingApp = (meetingModule as unknown as {
    createMeetingApp?: MeetingAppFactory;
  }).createMeetingApp;
  const App = createMeetingApp?.({
    socketFactory: (url: string) => new FakeSocket(url),
    retryScheduler,
    captureOptions: {
      workerFactory: () => new FakeWorker(),
      frameFactory: () => ({ close: vi.fn() }) as unknown as ImageBitmap,
      scheduler: captureScheduler,
      clock: { now: () => clock.value },
      uuidFactory: () => streamIds.shift() ?? "44444444-4444-4444-8444-444444444444",
      assets: {
        wasmRootUrl: "/mediapipe/wasm",
        handModelUrl: "/mediapipe/hand.task",
        poseModelUrl: "/mediapipe/pose.task"
      }
    },
    clock: { now: () => clock.value },
    trackingAnnouncementDelayMs: 20
  }) ?? MeetingApp;
  const rendered = render(<App />);
  const video = rendered.container.querySelector("video");
  if (!video) throw new Error("Meeting video element is missing");
  Object.defineProperties(video, {
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    videoWidth: { configurable: true, value: 640 },
    videoHeight: { configurable: true, value: 480 }
  });
  return {
    user: userEvent.setup(),
    captureScheduler,
    retryScheduler,
    clock,
    track,
    unmount: rendered.unmount,
    video
  };
}

async function enableCamera(harness: Harness): Promise<void> {
  await harness.user.click(screen.getByRole("button", { name: "Turn camera on" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Turn camera off" })).toBeEnabled());
}

async function connectSession(harness: Harness): Promise<FakeSocket> {
  await harness.user.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  await screen.findByRole("button", { name: "Session active" });
  return socket;
}

async function startRecognition(harness: Harness, socket: FakeSocket): Promise<FakeWorker> {
  const start = await screen.findByRole("button", { name: "Start recognition" });
  start.focus();
  await harness.user.keyboard("{Enter}");
  await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  act(() => worker.emit({ type: "worker.ready" }));
  await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
    schemaVersion: 1,
    type: "recognition.control",
    streamId: "11111111-1111-4111-8111-111111111111",
    sequence: 0,
    action: "start"
  })));
  return worker;
}

async function emitAcceptedFrame(harness: Harness, worker: FakeWorker, frameKind: "active" | "idle" = "active") {
  harness.clock.value += 40;
  await act(async () => {
    harness.captureScheduler.step(harness.clock.value);
    await Promise.resolve();
    await Promise.resolve();
  });
  const request = worker.posted.filter((message) => message.type === "frame.process").at(-1);
  if (!request) throw new Error("Capture did not post a frame");
  act(() => worker.emit({
    type: "frame.result",
    requestId: request.requestId,
    timestampMs: request.timestampMs,
    result: {
      kind: "accepted",
      frameKind,
      features: activeChunkFixture.frames[0].features
    }
  }));
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakeWorker.instances = [];
});

describe("Meeting recognition product UX", () => {
  it("keeps camera preview separate from keyboard-operated recognition consent", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    expect(socket.sent).toHaveLength(0);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Start recognition" }))
      .toHaveAccessibleDescription(/transient hand and body landmark transmission.*raw video is not transmitted/i);

    const worker = await startRecognition(harness, socket);
    for (let index = 0; index < 5; index += 1) {
      await emitAcceptedFrame(harness, worker);
    }
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(1);

    const stop = screen.getByRole("button", { name: "Stop recognition" });
    stop.focus();
    await harness.user.keyboard(" ");
    await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      sequence: 1,
      action: "stop"
    })));
    expect(screen.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("routes only validated final captions to the transcript and discloses mock metadata", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    await startRecognition(harness, socket);

    act(() => {
      socket.message(captionFixture);
      socket.message(unknownFixture);
      socket.message(readyFixture);
      socket.message({ ...captionFixture, type: "caption.partial" });
      socket.messageRaw("{malformed");
    });

    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getByText("Synthetic active gesture")).toBeVisible();
    expect(within(transcript).getAllByRole("article")).toHaveLength(1);
    expect(within(transcript).getByText(/synthetic-v1/i)).toBeVisible();
    expect(within(transcript).getByRole("note")).toHaveTextContent(/mock integration model/i);
    expect(screen.getByText(/sign was not recognized/i)).toBeVisible();
    expect(screen.getByText(/unsupported realtime event was ignored/i)).toBeVisible();
  });

  it("keeps capture pressure bounded to the newest chunk without exposing landmarks in React", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    socket.bufferedAmount = 1024 * 1024;

    for (let index = 0; index < 15; index += 1) {
      await emitAcceptedFrame(harness, worker);
    }
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(0);

    socket.bufferedAmount = 0;
    await emitAcceptedFrame(harness, worker);
    const chunks = socket.parsedSent().filter((event) => event.type === "landmark.chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sequence: 2 });
    expect(document.body.textContent).not.toContain("-0.45");
  });

  it("restarts with a fresh stream after reconnect and ignores the stale socket generation", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const firstSocket = await connectSession(harness);
    const firstWorker = await startRecognition(harness, firstSocket);

    act(() => firstSocket.failClose());
    expect(screen.getByText("Reconnecting in 250 ms")).toBeVisible();
    expect(harness.retryScheduler.delays).toEqual([250]);
    act(() => harness.retryScheduler.runNext());
    const secondSocket = FakeSocket.instances[1];
    act(() => secondSocket.open());
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const secondWorker = FakeWorker.instances[1];
    act(() => secondWorker.emit({ type: "worker.ready" }));

    await waitFor(() => expect(secondSocket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      streamId: "33333333-3333-4333-8333-333333333333",
      sequence: 0,
      action: "start"
    })));
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByText(/connection recovered/i)).toBeVisible();

    act(() => firstSocket.message(captionFixture));
    expect(screen.queryByText("Synthetic active gesture")).not.toBeInTheDocument();
    act(() => secondSocket.message({
      ...captionFixture,
      streamId: "33333333-3333-4333-8333-333333333333"
    }));
    expect(screen.getByText("Synthetic active gesture")).toBeVisible();
  });

  it("shows unavailable, timeout, recovery, loading, idle, and low-quality states outside the transcript", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    const start = screen.getByRole("button", { name: "Start recognition" });
    await harness.user.click(start);
    expect(screen.getByText(/mediapipe model is loading/i)).toBeVisible();
    expect(socket.sent).toHaveLength(0);
    const worker = FakeWorker.instances[0];
    act(() => worker.emit({ type: "worker.ready" }));
    await screen.findByText(/tracking is ready/i);

    await emitAcceptedFrame(harness, worker, "idle");
    await screen.findByText(/no hands detected/i);
    await act(async () => {
      harness.clock.value += 40;
      harness.captureScheduler.step(harness.clock.value);
      await Promise.resolve();
      await Promise.resolve();
    });
    const request = worker.posted.filter((message) => message.type === "frame.process").at(-1)!;
    act(() => worker.emit({
      type: "frame.result",
      requestId: request.requestId,
      timestampMs: request.timestampMs,
      result: { kind: "rejected", reason: "LOW_QUALITY" }
    }));
    await screen.findByText(/tracking quality is low/i);

    act(() => socket.message(unavailableFixture));
    expect(screen.getByRole("status", { name: "Recognition service status" })).toHaveTextContent(/timed out|temporarily unavailable/i);
    act(() => socket.message({
      ...readyFixture,
      payload: { ...readyFixture.payload, reason: "RECOVERED", message: "Recognition is available again." }
    }));
    expect(screen.getByRole("status", { name: "Recognition service status" })).toHaveTextContent(/available again|recovered/i);
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    act(() => worker.emit({
      type: "worker.error",
      code: "MODEL_UNAVAILABLE",
      message: "model fetch failed",
      fatal: true
    }));
    await screen.findByText(/mediapipe model is unavailable/i);
    expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled();
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      sequence: 1,
      action: "stop"
    }));
  });

  it("stops capture and media exactly once on camera off and unmount", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const firstWorker = await startRecognition(harness, socket);

    await harness.user.click(screen.getByRole("button", { name: "Turn camera off" }));
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(screen.getByText(/recognition stopped/i)).toBeVisible();

    harness.unmount();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("stops recognition and clears the preview when the active camera track ends externally", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);

    expect(harness.track.endedListenerCount).toBe(1);
    act(() => harness.track.end());

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/camera.*disconnected|permission.*revoked/i);
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeEnabled();
    expect(harness.video.srcObject).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.track.endedListenerCount).toBe(0);
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      streamId: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      action: "stop"
    }));

    act(() => harness.track.end());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
  });

  it("ignores ended events from a removed track after a new camera stream is active", async () => {
    const firstTrack = new FakeMediaTrack();
    const secondTrack = new FakeMediaTrack();
    const streams = [
      { getTracks: () => [firstTrack] } as unknown as MediaStream,
      { getTracks: () => [secondTrack] } as unknown as MediaStream
    ];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => streams.shift()!) }
    });
    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const App = createMeetingApp?.() ?? MeetingApp;
    const rendered = render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Turn camera on" }));
    await screen.findByRole("button", { name: "Turn camera off" });
    await user.click(screen.getByRole("button", { name: "Turn camera off" }));
    await user.click(screen.getByRole("button", { name: "Turn camera on" }));
    await screen.findByRole("button", { name: "Turn camera off" });

    expect(firstTrack.endedListenerCount).toBe(0);
    expect(secondTrack.endedListenerCount).toBe(1);
    act(() => firstTrack.end());

    expect(screen.getByRole("button", { name: "Turn camera off" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(secondTrack.stop).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it("accepts STOPPED for the just-stopped stream but rejects old-stream events after restart", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    await startRecognition(harness, socket);

    await harness.user.click(screen.getByRole("button", { name: "Stop recognition" }));
    expect(screen.getByText(/^Recognition stopped\.$/i)).toBeVisible();
    act(() => socket.message({
      ...readyFixture,
      type: "recognition.status",
      streamId: "11111111-1111-4111-8111-111111111111",
      sequence: 2,
      payload: {
        ...readyFixture.payload,
        state: "STOPPED",
        reason: "STOPPED_BY_CLIENT",
        message: "Stream stopped."
      }
    }));
    expect(screen.getByRole("status", { name: "Recognition service status" }))
      .toHaveTextContent(/^Recognition stopped\.$/i);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const nextWorker = FakeWorker.instances[1];
    act(() => nextWorker.emit({ type: "worker.ready" }));
    await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      streamId: "33333333-3333-4333-8333-333333333333",
      sequence: 0,
      action: "start"
    })));
    act(() => socket.message({
      ...readyFixture,
      streamId: "33333333-3333-4333-8333-333333333333",
      sequence: 3,
      payload: { ...readyFixture.payload, message: "New stream ready." }
    }));
    expect(screen.getByRole("status", { name: "Recognition service status" }))
      .toHaveTextContent("New stream ready.");

    act(() => {
      socket.message({
        ...readyFixture,
        streamId: "11111111-1111-4111-8111-111111111111",
        sequence: 4,
        payload: {
          ...readyFixture.payload,
          state: "STOPPED",
          reason: "STOPPED_BY_CLIENT",
          message: "Old stream stopped."
        }
      });
      socket.message(captionFixture);
    });
    expect(screen.getByRole("status", { name: "Recognition service status" }))
      .toHaveTextContent("New stream ready.");
    expect(screen.queryByText("Synthetic active gesture")).not.toBeInTheDocument();
  });

  it("stops every late camera track without touching the unmounted preview", async () => {
    const cameraRequest = deferred<MediaStream>();
    const firstTrack = { stop: vi.fn() };
    const secondTrack = { stop: vi.fn() };
    const stream = { getTracks: () => [firstTrack, secondTrack] } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => cameraRequest.promise);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });
    const createSocket = vi.fn((url: string) => new FakeSocket(url));
    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const App = createMeetingApp?.({ socketFactory: createSocket }) ?? MeetingApp;
    const rendered = render(<App />);
    const video = rendered.container.querySelector("video");
    if (!video) throw new Error("Meeting video element is missing");
    const assignPreview = vi.fn();
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      get: () => null,
      set: assignPreview
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await userEvent.setup().click(screen.getByRole("button", { name: "Turn camera on" }));
    expect(getUserMedia).toHaveBeenCalledOnce();
    rendered.unmount();

    await act(async () => {
      cameraRequest.resolve(stream);
      await cameraRequest.promise;
    });

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(secondTrack.stop).toHaveBeenCalledOnce();
    expect(assignPreview).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps the newest camera request when an older request resolves last", async () => {
    const firstRequest = deferred<MediaStream>();
    const secondRequest = deferred<MediaStream>();
    const requests = [firstRequest, secondRequest];
    const getUserMedia = vi.fn(() => requests.shift()!.promise);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });
    const staleTrack = new FakeMediaTrack();
    const currentTrack = new FakeMediaTrack();
    const staleStream = { getTracks: () => [staleTrack] } as unknown as MediaStream;
    const currentStream = { getTracks: () => [currentTrack] } as unknown as MediaStream;
    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const App = createMeetingApp?.() ?? MeetingApp;
    const rendered = render(<App />);
    const video = rendered.container.querySelector("video");
    if (!video) throw new Error("Meeting video element is missing");
    const assignPreview = vi.fn();
    Object.defineProperty(video, "srcObject", {
      configurable: true,
      get: () => null,
      set: assignPreview
    });
    const cameraButton = screen.getByRole("button", { name: "Turn camera on" });

    act(() => {
      cameraButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      cameraButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRequest.resolve(currentStream);
      await secondRequest.promise;
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Turn camera off" });

    await act(async () => {
      firstRequest.resolve(staleStream);
      await firstRequest.promise;
      await Promise.resolve();
    });

    expect(staleTrack.stop).toHaveBeenCalledOnce();
    expect(currentTrack.stop).not.toHaveBeenCalled();
    expect(assignPreview).toHaveBeenCalledTimes(1);
    expect(assignPreview).toHaveBeenLastCalledWith(currentStream);

    rendered.unmount();
    expect(currentTrack.stop).toHaveBeenCalledOnce();
  });

  it("does not open a session when meeting creation resolves after unmount", async () => {
    const meetingRequest = deferred<Response>();
    const requestMeeting = vi.fn(() => meetingRequest.promise);
    vi.stubGlobal("fetch", requestMeeting);
    const createSocket = vi.fn((url: string) => new FakeSocket(url));
    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const App = createMeetingApp?.({ socketFactory: createSocket }) ?? MeetingApp;
    const rendered = render(<App />);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await userEvent.setup().click(screen.getByRole("button", { name: "Start session" }));
    expect(requestMeeting).toHaveBeenCalledOnce();
    rendered.unmount();

    await act(async () => {
      meetingRequest.resolve({
        ok: true,
        json: async () => meeting
      } as Response);
      await meetingRequest.promise;
      await Promise.resolve();
    });

    expect(createSocket).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("lets only the newest meeting request create the active session", async () => {
    const firstRequest = deferred<Response>();
    const secondRequest = deferred<Response>();
    const requests = [firstRequest, secondRequest];
    const requestMeeting = vi.fn(() => requests.shift()!.promise);
    vi.stubGlobal("fetch", requestMeeting);
    const createSocket = vi.fn((url: string) => new FakeSocket(url));
    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const App = createMeetingApp?.({ socketFactory: createSocket }) ?? MeetingApp;
    render(<App />);
    const startSession = screen.getByRole("button", { name: "Start session" });

    act(() => {
      startSession.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      startSession.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(requestMeeting).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRequest.resolve({ ok: true, json: async () => meeting } as Response);
      await secondRequest.promise;
      await Promise.resolve();
    });
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(createSocket).toHaveBeenLastCalledWith(expect.stringContaining(meeting.id));

    const staleMeeting = {
      ...meeting,
      id: "55555555-5555-4555-8555-555555555555"
    };
    await act(async () => {
      firstRequest.resolve({ ok: true, json: async () => staleMeeting } as Response);
      await firstRequest.promise;
      await Promise.resolve();
    });

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`Room ${meeting.id.slice(0, 8)}`)).toBeVisible();
  });

  it("cannot enable simulator controls through the public runtime composition seam", () => {
    const production = makeHarness();
    expect(screen.queryByText("Recognizer simulator")).not.toBeInTheDocument();
    production.unmount();

    const createMeetingApp = (meetingModule as unknown as {
      createMeetingApp?: MeetingAppFactory;
    }).createMeetingApp;
    const RuntimeOverrideAttempt = createMeetingApp?.({ simulatorEnabled: true }) ?? MeetingApp;
    render(<RuntimeOverrideAttempt />);
    expect(screen.queryByText("Recognizer simulator")).not.toBeInTheDocument();
  });

  it("provides disabled explanations and coalesces rapid tracking announcements", async () => {
    const harness = makeHarness();
    const start = screen.getByRole("button", { name: "Start recognition" });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription(/turn on the camera.*start a session/i);

    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "active");
    await emitAcceptedFrame(harness, worker, "idle");

    const announcement = screen.getByRole("status", { name: "Tracking announcement" });
    await waitFor(() => expect(announcement).toHaveTextContent(/no hands detected/i));
    expect(screen.getAllByRole("status", { name: "Tracking announcement" })).toHaveLength(1);
  });

  it("keeps every capture status accessible without duplicating live announcements", async () => {
    const harness = makeHarness();
    const expectAccessibleStatus = (text: RegExp) => {
      const statusText = screen.getByText(text);
      expect(statusText.closest("[aria-hidden='true']")).toBeNull();
    };

    expectAccessibleStatus(/^Recognition stopped\.$/i);
    await enableCamera(harness);
    await connectSession(harness);
    Object.defineProperty(harness.video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_NOTHING
    });
    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    expectAccessibleStatus(/mediapipe model is loading/i);

    const firstWorker = FakeWorker.instances[0];
    act(() => firstWorker.emit({ type: "worker.ready" }));
    expectAccessibleStatus(/waiting for camera frames/i);

    Object.defineProperty(harness.video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA
    });
    await act(async () => {
      harness.captureScheduler.step(40);
      await Promise.resolve();
      await Promise.resolve();
    });
    expectAccessibleStatus(/tracking is ready/i);

    await emitAcceptedFrame(harness, firstWorker, "active");
    expectAccessibleStatus(/hands are being tracked/i);
    await emitAcceptedFrame(harness, firstWorker, "idle");
    expectAccessibleStatus(/no hands detected/i);

    await act(async () => {
      harness.clock.value += 40;
      harness.captureScheduler.step(harness.clock.value);
      await Promise.resolve();
      await Promise.resolve();
    });
    const rejectedRequest = firstWorker.posted.filter((message) => message.type === "frame.process").at(-1)!;
    act(() => firstWorker.emit({
      type: "frame.result",
      requestId: rejectedRequest.requestId,
      timestampMs: rejectedRequest.timestampMs,
      result: { kind: "rejected", reason: "LOW_QUALITY" }
    }));
    expectAccessibleStatus(/tracking quality is low/i);

    act(() => firstWorker.emit({
      type: "worker.error",
      code: "FRAME_PROCESSING_FAILED",
      message: "frame failed",
      fatal: true
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled());
    expectAccessibleStatus(/landmark tracking stopped after an unexpected error/i);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const secondWorker = FakeWorker.instances[1];
    act(() => secondWorker.emit({
      type: "worker.error",
      code: "MODEL_UNAVAILABLE",
      message: "model fetch failed",
      fatal: true
    }));
    await screen.findByText(/mediapipe model is unavailable/i);
    expectAccessibleStatus(/mediapipe model is unavailable/i);

    expect(screen.getAllByRole("status", { name: "Tracking announcement" })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Tracking announcement" })).toBeEmptyDOMElement();
  });
});
