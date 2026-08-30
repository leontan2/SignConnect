import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import activeChunkFixture from "../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import captionFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import readyFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-ready.valid.json";
import unavailableFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-unavailable.valid.json";
import unknownFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-unknown.valid.json";
import roomNotFoundFixture from "../../../../contracts/realtime-room/v1/fixtures/server-room-error-room-not-found.valid.json";
import MeetingApp, * as meetingModule from "./MeetingApp";

const meeting = {
  id: captionFixture.meetingId,
  title: "Accessible team sync",
  joinCode: "ABC234",
  status: "READY",
  createdAt: "2026-01-01T00:00:00Z"
} as const;

const meetingSession = {
  meeting,
  participant: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "You",
    role: "HOST"
  },
  realtimeTicket: "signed-realtime-ticket",
  realtimeTicketExpiresAt: "2026-01-01T04:00:00Z"
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
  failNextSendForType: string | null = null;
  failLandmarkSendAt: number | null = null;
  private landmarkSendCount = 0;
  readonly close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    const event = JSON.parse(data) as { type?: string };
    if (event.type === "landmark.chunk") {
      this.landmarkSendCount += 1;
      if (this.landmarkSendCount === this.failLandmarkSendAt) {
        throw new Error(`Failed landmark send ${this.landmarkSendCount}`);
      }
    }
    if (event.type === this.failNextSendForType) {
      this.failNextSendForType = null;
      throw new Error(`Failed to send ${event.type}`);
    }
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

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

type MeetingAppFactory = (options?: Record<string, unknown>) => React.ComponentType;

type Harness = {
  user: ReturnType<typeof userEvent.setup>;
  captureScheduler: ManualScheduler;
  retryScheduler: ManualRetryScheduler;
  clock: { value: number };
  roomSequence: { value: number };
  track: FakeMediaTrack;
  getUserMedia: ReturnType<typeof vi.fn>;
  unmount(): void;
  video: HTMLVideoElement;
};

function makeHarness(): Harness {
  const captureScheduler = new ManualScheduler();
  const retryScheduler = new ManualRetryScheduler();
  const clock = { value: 0 };
  const roomSequence = { value: 1 };
  const streamIds = [
    "11111111-1111-4111-8111-111111111111",
    "33333333-3333-4333-8333-333333333333"
  ];
  const requestIds = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888"
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
    json: async () => meetingSession
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
    requestIdFactory: () => requestIds.shift() ?? "99999999-9999-4999-8999-999999999999",
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
    roomSequence,
    track,
    getUserMedia,
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
  expect(socket.parsedSent()).toContainEqual({
    schemaVersion: 1,
    type: "room.join",
    ticket: meetingSession.realtimeTicket
  });
  act(() => {
    socket.message({
      schemaVersion: 1,
      type: "room.joined",
      meetingId: meeting.id,
      participantId: meetingSession.participant.id,
      sequence: 0,
      payload: { displayName: "You", role: "HOST" },
      occurredAt: meeting.createdAt
    });
    socket.message({
      schemaVersion: 1,
      type: "room.snapshot",
      meetingId: meeting.id,
      sequence: 1,
      payload: {
        participants: [{
          participantId: meetingSession.participant.id,
          displayName: "You",
          role: "HOST"
        }]
      },
      occurredAt: meeting.createdAt
    });
  });
  await screen.findByRole("button", { name: "Session active" });
  return socket;
}

async function grantPendingSigner(harness: Harness, socket: FakeSocket): Promise<Record<string, unknown>> {
  const signerRequest = await waitFor(() => {
    const request = socket.parsedSent().filter((event) => event.type === "signer.request").at(-1);
    expect(request).toBeDefined();
    return request!;
  });
  act(() => socket.message({
    schemaVersion: 1,
    type: "signer.granted",
    meetingId: meeting.id,
    participantId: meetingSession.participant.id,
    sequence: ++harness.roomSequence.value,
    payload: {
      requestId: signerRequest.requestId,
      streamId: signerRequest.streamId
    },
    occurredAt: meeting.createdAt
  }));
  return signerRequest;
}

async function startRecognition(harness: Harness, socket: FakeSocket): Promise<FakeWorker> {
  const start = await screen.findByRole("button", { name: "Start recognition" });
  start.focus();
  await harness.user.keyboard("{Enter}");
  await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  act(() => worker.emit({ type: "worker.ready" }));
  await waitFor(() => expect(socket.parsedSent().some((event) => event.type === "signer.request")).toBe(true));
  expect(socket.parsedSent().filter((event) => event.type === "recognition.control")).toHaveLength(0);
  await grantPendingSigner(harness, socket);
  await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
    schemaVersion: 1,
    type: "recognition.control",
    streamId: "11111111-1111-4111-8111-111111111111",
    sequence: 0,
    action: "start"
  })));
  return worker;
}

async function emitAcceptedFrame(
  harness: Harness,
  worker: FakeWorker,
  frameKind: "active" | "idle" = "active",
  browserLocal?: Record<string, unknown>
) {
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
    },
    ...(browserLocal ? { browserLocal } : {})
  }));
}

function completedGestureCandidate(startTimestampMs: number) {
  return Array.from({ length: 30 }, (_unused, index) => ({
    timestampMs: startTimestampMs + index * 40,
    features: [...activeChunkFixture.frames[index % activeChunkFixture.frames.length].features]
  }));
}

async function emitCompletedGesture(harness: Harness, worker: FakeWorker) {
  const candidate = completedGestureCandidate(harness.clock.value + 40);
  harness.clock.value = candidate.at(-1)!.timestampMs;
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
      frameKind: "active",
      features: activeChunkFixture.frames[0].features
    },
    gestureCandidate: candidate
  }));
  return candidate;
}

beforeEach(() => {
  FakeSocket.instances = [];
  FakeWorker.instances = [];
});

describe("Meeting recognition product UX", () => {
  it("joins an existing room with the participant name and normalized share code", async () => {
    const harness = makeHarness();
    const name = screen.getByLabelText("Display name");
    const code = screen.getByLabelText("Room code");

    await harness.user.clear(name);
    await harness.user.type(name, "Ari");
    await harness.user.type(code, "xy7p9q");
    await harness.user.click(screen.getByRole("button", { name: "Join room" }));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/meetings/XY7P9Q/participants"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Ari" })
      })
    );
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(FakeSocket.instances[0].url).toContain(meeting.id);
  });

  it("keeps camera preview separate from keyboard-operated recognition consent", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    expect(harness.getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 960 },
        aspectRatio: { ideal: 4 / 3 },
        facingMode: "user"
      },
      audio: false
    });
    const socket = await connectSession(harness);

    expect(socket.parsedSent().filter((event) => event.type === "recognition.control"
      || event.type === "landmark.chunk")).toHaveLength(0);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Start recognition" }))
      .toHaveAccessibleDescription(/transient hand and body landmark transmission.*raw video is not transmitted/i);

    const worker = await startRecognition(harness, socket);
    for (let index = 0; index < 15; index += 1) {
      await emitAcceptedFrame(harness, worker);
    }
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(0);

    const candidate = await emitCompletedGesture(harness, worker);
    const chunks = socket.parsedSent().filter((event) => event.type === "landmark.chunk");
    expect(chunks).toHaveLength(6);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    const frames = chunks.flatMap((chunk) => chunk.frames as Array<Record<string, unknown>>);
    expect(frames.map((frame) => frame.sequence)).toEqual(Array.from({ length: 30 }, (_unused, index) => index));
    expect(frames.map((frame) => frame.timestampMs)).toEqual(candidate.map((frame) => frame.timestampMs));
    expect(chunks.every((chunk) => (chunk.frames as unknown[]).length === 5)).toBe(true);

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
    expect(socket.parsedSent().filter((event) => event.type === "signer.release")).toHaveLength(0);
    const signerCommands = socket.parsedSent().filter((event) =>
      event.type === "signer.request" || event.type === "signer.release"
    );
    expect(signerCommands).toHaveLength(1);
    expect(signerCommands[0].sequence).toBe(0);
  });

  it("toggles the decorative tracking overlay by keyboard without moving focus or disabling recognition", async () => {
    const harness = makeHarness();
    const toggle = screen.getByRole("button", { name: "Tracking overlay" });
    const overlay = document.querySelector("canvas.landmark-overlay");

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Tracking overlay: On");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toBeVisible();

    await enableCamera(harness);
    await connectSession(harness);
    const start = screen.getByRole("button", { name: "Start recognition" });
    expect(start).toBeEnabled();

    toggle.focus();
    await harness.user.keyboard(" ");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Tracking overlay: Off");
    expect(overlay).not.toBeVisible();
    expect(start).toBeEnabled();

    await harness.user.keyboard("{Enter}");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Tracking overlay: On");
    expect(overlay).toBeVisible();
    expect(start).toBeEnabled();
  });

  it("turns browser-local quality, calibration, and gesture phases into actionable readiness guidance", async () => {
    const harness = makeHarness();
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/camera off/i);
    await enableCamera(harness);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/camera initializing/i);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/camera initializing/i);

    const states = [
      ["no-person", "No person detected"],
      ["upper-body-missing", "Upper body not fully visible"],
      ["left-hand-missing", "Left hand missing"],
      ["right-hand-missing", "Right hand missing"],
      ["out-of-frame", "Hands too close to the frame edge"],
      ["low-quality", "Lighting or tracking quality too poor"]
    ] as const;
    for (const [state, label] of states) {
      await emitAcceptedFrame(harness, worker, state === "no-person" ? "idle" : "active", {
        timestampMs: harness.clock.value,
        gestureModel: "unavailable",
        hands: [],
        upperBody: [],
        gesture: null,
        trackingQuality: {
          state,
          personDetected: state !== "no-person",
          upperBodyVisible: !["no-person", "upper-body-missing"].includes(state),
          leftHandVisible: !["no-person", "upper-body-missing", "left-hand-missing"].includes(state),
          rightHandVisible: !["no-person", "upper-body-missing", "right-hand-missing"].includes(state),
          handsInsideFrame: state !== "out-of-frame"
        },
        calibration: { state: "collecting", stableFrames: 0, requiredStableFrames: 8 },
        gesturePhase: "idle"
      });
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(label);
    }

    await emitAcceptedFrame(harness, worker, "active", {
      timestampMs: harness.clock.value,
      gestureModel: "unavailable",
      hands: [],
      upperBody: [],
      gesture: null,
      trackingQuality: {
        state: "ready",
        personDetected: true,
        upperBodyVisible: true,
        leftHandVisible: true,
        rightHandVisible: true,
        handsInsideFrame: true
      },
      calibration: { state: "collecting", stableFrames: 4, requiredStableFrames: 8 },
      gesturePhase: "idle"
    });
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/camera initializing/i);

    await emitAcceptedFrame(harness, worker, "active", {
      timestampMs: harness.clock.value,
      gestureModel: "unavailable",
      hands: [],
      upperBody: [],
      gesture: null,
      trackingQuality: {
        state: "ready",
        personDetected: true,
        upperBodyVisible: true,
        leftHandVisible: true,
        rightHandVisible: true,
        handsInsideFrame: true
      },
      calibration: { state: "ready", stableFrames: 8, requiredStableFrames: 8 },
      gesturePhase: "active"
    });
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/gesture in progress/i);

    await emitAcceptedFrame(harness, worker, "active", {
      timestampMs: harness.clock.value,
      gestureModel: "unavailable",
      hands: [],
      upperBody: [],
      gesture: null,
      trackingQuality: {
        state: "ready",
        personDetected: true,
        upperBodyVisible: true,
        leftHandVisible: true,
        rightHandVisible: true,
        handsInsideFrame: true
      },
      calibration: { state: "ready", stableFrames: 8, requiredStableFrames: 8 },
      gesturePhase: "ready-for-inference"
    });
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      gestureModel: "unavailable",
      hands: [],
      upperBody: [],
      gesture: null,
      trackingQuality: {
        state: "ready",
        personDetected: true,
        upperBodyVisible: true,
        leftHandVisible: true,
        rightHandVisible: true,
        handsInsideFrame: true
      },
      calibration: { state: "ready", stableFrames: 8, requiredStableFrames: 8 },
      gesturePhase: "idle"
    });
    act(() => socket.message(unknownFixture));
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/sign not recognized/i);
    act(() => socket.message(captionFixture));
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/sign recognized/i);
    expect(screen.queryAllByRole("article")).toHaveLength(1);
  });

  it("releases signer ownership when tracking initialization fails after a grant", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const worker = FakeWorker.instances[0];
    await waitFor(() => expect(socket.parsedSent().some((event) => event.type === "signer.request")).toBe(true));
    await grantPendingSigner(harness, socket);
    act(() => worker.emit({
      type: "worker.error",
      code: "MODEL_UNAVAILABLE",
      message: "model fetch failed",
      fatal: true
    }));

    await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "signer.release",
      streamId: "11111111-1111-4111-8111-111111111111",
      reason: "recognition_stopped"
    })));
    expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled();
    expect(socket.parsedSent().filter((event) => event.type === "recognition.control")).toHaveLength(0);
  });

  it("does not process pre-grant frames and starts transmitted chunk sequencing at zero", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const worker = FakeWorker.instances[0];
    act(() => worker.emit({ type: "worker.ready" }));
    await waitFor(() => expect(socket.parsedSent().some((event) => event.type === "signer.request")).toBe(true));

    for (let index = 0; index < 10; index += 1) {
      act(() => {
        harness.clock.value += 40;
        harness.captureScheduler.step(harness.clock.value);
      });
    }
    expect(worker.posted.filter((message) => message.type === "frame.process")).toHaveLength(0);

    await grantPendingSigner(harness, socket);
    await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      action: "start"
    })));
    await emitCompletedGesture(harness, worker);

    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk"))
      .toHaveLength(6);
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({ type: "landmark.chunk", sequence: 0 }));
  });

  it("fails closed and reconnects when recognition start cannot be sent after a grant", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const worker = FakeWorker.instances[0];
    act(() => worker.emit({ type: "worker.ready" }));
    await waitFor(() => expect(socket.parsedSent().some((event) => event.type === "signer.request")).toBe(true));
    socket.failNextSendForType = "recognition.control";
    await grantPendingSigner(harness, socket);

    await waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, "Essential realtime send failed"));
    expect(screen.getByText("Reconnecting in 250 ms")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start recognition" })).toBeDisabled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("keeps recognition private until signer access is granted and explains denial", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const worker = FakeWorker.instances[0];
    act(() => worker.emit({ type: "worker.ready" }));
    const signerRequest = await waitFor(() => {
      const request = socket.parsedSent().find((event) => event.type === "signer.request");
      expect(request).toBeDefined();
      return request!;
    });
    expect(screen.getByRole("button", { name: "Cancel signer request" })).toBeEnabled();
    expect(socket.parsedSent().filter((event) => event.type === "recognition.control")).toHaveLength(0);

    act(() => socket.message({
      schemaVersion: 1,
      type: "signer.denied",
      meetingId: meeting.id,
      streamId: signerRequest.streamId,
      sequence: 2,
      payload: {
        requestId: signerRequest.requestId,
        reason: "SIGNER_UNAVAILABLE"
      },
      occurredAt: meeting.createdAt
    }));

    await within(screen.getByRole("contentinfo", { name: "Capture controls" }))
      .findByText(/another participant is the active signer/i);
    expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(socket.parsedSent().filter((event) => event.type === "recognition.control")).toHaveLength(0);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const retryWorker = FakeWorker.instances[1];
    act(() => retryWorker.emit({ type: "worker.ready" }));
    const requests = await waitFor(() => {
      const sent = socket.parsedSent().filter((event) => event.type === "signer.request");
      expect(sent).toHaveLength(2);
      return sent;
    });
    expect(requests[1].sequence).toBe(1);
    expect(requests[1].timestampMs).toBeGreaterThan(requests[0].timestampMs as number);
  });

  it("keeps public room state ordered and inserts a stable caption only once", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    const guestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const captionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const roomCaption = {
      ...captionFixture,
      participantId: guestId,
      captionId,
      sequence: 4,
      payload: {
        ...captionFixture.payload,
        sourceDisplayName: "Ari"
      }
    };

    act(() => {
      socket.message({
        schemaVersion: 1,
        type: "participant.joined",
        meetingId: meeting.id,
        participantId: guestId,
        sequence: 3,
        payload: { displayName: "Ari", role: "GUEST", activeSigner: false },
        occurredAt: meeting.createdAt
      });
      socket.message({
        schemaVersion: 1,
        type: "room.snapshot",
        meetingId: meeting.id,
        sequence: 2,
        payload: { participants: [] },
        occurredAt: meeting.createdAt
      });
      socket.message(roomCaption);
      socket.message({ ...roomCaption, sequence: 5 });
    });

    expect(within(screen.getByLabelText("People in this room")).getByText("Ari")).toBeVisible();
    expect(screen.getByText(/room updates arrived out of order/i)).toBeVisible();
    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getAllByRole("article")).toHaveLength(1);
    expect(within(transcript).getByText("Synthetic active gesture")).toBeVisible();
  });

  it("accepts a forward room sequence after a snapshot without reporting false disorder", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);

    act(() => socket.message({
      schemaVersion: 1,
      type: "participant.joined",
      meetingId: meeting.id,
      participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sequence: 3,
      payload: { displayName: "Ari", role: "GUEST", activeSigner: false },
      occurredAt: meeting.createdAt
    }));

    expect(within(screen.getByLabelText("People in this room")).getByText("Ari")).toBeVisible();
    expect(screen.queryByText(/room updates arrived out of order/i)).not.toBeInTheDocument();
  });

  it("distinguishes an expired realtime ticket from a temporary reconnect", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);

    act(() => socket.message({
      ...captionFixture,
      participantId: meetingSession.participant.id,
      captionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sequence: 2,
      payload: {
        ...captionFixture.payload,
        sourceDisplayName: "You"
      }
    }));
    expect(screen.getByText("Synthetic active gesture")).toBeVisible();
    expect(screen.getByText(/mock integration model/i)).toBeVisible();

    act(() => socket.message({
      schemaVersion: 1,
      type: "room.error",
      meetingId: meeting.id,
      sequence: 3,
      payload: { code: "TICKET_EXPIRED", message: "Ticket expired." },
      occurredAt: meeting.createdAt
    }));

    expect(screen.getByLabelText("Meeting error")).toHaveTextContent(/realtime ticket expired.*rejoin/i);
    expect(screen.getByText("Not connected")).toBeVisible();
    expect(screen.queryByText("Synthetic active gesture")).not.toBeInTheDocument();
    expect(screen.queryByText(/mock integration model/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("0 final captions")).toBeVisible();
  });

  it("surfaces a missing room after resume and returns to a clean room entry", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    await enableCamera(harness);
    expect(harness.video.srcObject).not.toBeNull();

    act(() => {
      socket.message({
        schemaVersion: 1,
        type: "room.joined",
        meetingId: meeting.id,
        participantId: meetingSession.participant.id,
        resumeToken: "short-lived-resume-token",
        resumeExpiresAt: "2026-08-30T14:00:00Z",
        sequence: 0,
        payload: { displayName: "You", role: "HOST", activeSigner: false },
        occurredAt: meeting.createdAt
      });
      socket.message({
        ...captionFixture,
        participantId: meetingSession.participant.id,
        captionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sequence: 2,
        payload: {
          ...captionFixture.payload,
          sourceDisplayName: "You"
        }
      });
    });
    expect(screen.getByText("Synthetic active gesture")).toBeVisible();
    expect(screen.getByText(/mock integration model/i)).toBeVisible();

    act(() => socket.failClose());
    expect(screen.getByText("Reconnecting in 250 ms")).toBeVisible();
    act(() => harness.retryScheduler.runNext());
    const resumedSocket = FakeSocket.instances[1];
    act(() => resumedSocket.open());
    expect(resumedSocket.parsedSent()).toContainEqual({
      schemaVersion: 1,
      type: "room.join",
      resumeToken: "short-lived-resume-token"
    });

    act(() => resumedSocket.message(roomNotFoundFixture));

    expect(await screen.findByRole("alert")).toHaveTextContent(/room no longer exists/i);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Open a shared room" })).toBeVisible();
    expect(screen.queryByText("Synthetic active gesture")).not.toBeInTheDocument();
    expect(screen.queryByText(/mock integration model/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("0 final captions")).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeEnabled();
    expect(harness.video.srcObject).toBeNull();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.retryScheduler.pendingCount).toBe(0);

    act(() => resumedSocket.failClose());
    expect(harness.retryScheduler.pendingCount).toBe(0);
  });

  it("keeps caption announcements available after invite copying fails", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("Clipboard denied"); }) }
    });

    await harness.user.click(screen.getByRole("button", { name: "Copy room invitation" }));
    expect(await screen.findByLabelText("Meeting error")).toHaveTextContent(`Copy this room code: ${meeting.joinCode}`);
    const announcement = screen.getByRole("status", { name: "Meeting announcements" });
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);

    act(() => socket.message({
      ...captionFixture,
      participantId: meetingSession.participant.id,
      captionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sequence: 2,
      payload: {
        ...captionFixture.payload,
        sourceDisplayName: "You"
      }
    }));

    await waitFor(() => expect(announcement).toHaveTextContent(/caption from you: synthetic active gesture/i));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
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

  it("fails closed without retaining a completed gesture when realtime is pressured", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    socket.bufferedAmount = 1024 * 1024;

    await emitCompletedGesture(harness, worker);
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(0);
    await waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, "Essential realtime send blocked"));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByText("Reconnecting in 250 ms")).toBeVisible();
    expect(document.body.textContent).not.toContain("-0.45");
  });

  it("stops the stream if a completed gesture can only be sent partially", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    socket.failLandmarkSendAt = 3;

    await emitCompletedGesture(harness, worker);

    const chunks = socket.parsedSent().filter((event) => event.type === "landmark.chunk");
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      sequence: 1,
      action: "stop"
    }));
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled();
  });

  it("keeps chunk, frame, and timestamp ordering monotonic across completed gestures", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);

    await emitCompletedGesture(harness, worker);
    await emitCompletedGesture(harness, worker);

    const chunks = socket.parsedSent().filter((event) => event.type === "landmark.chunk");
    const frames = chunks.flatMap((chunk) => chunk.frames as Array<Record<string, unknown>>);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual(Array.from({ length: 12 }, (_unused, index) => index));
    expect(frames.map((frame) => frame.sequence)).toEqual(Array.from({ length: 60 }, (_unused, index) => index));
    const timestamps = frames.map((frame) => frame.timestampMs as number);
    expect(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1])).toBe(true);
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
    act(() => {
      secondSocket.open();
      secondSocket.message({
        schemaVersion: 1,
        type: "room.joined",
        meetingId: meeting.id,
        participantId: meetingSession.participant.id,
        sequence: 3,
        payload: { displayName: "You", role: "HOST" },
        occurredAt: meeting.createdAt
      });
    });
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
    const secondWorker = FakeWorker.instances[1];
    act(() => secondWorker.emit({ type: "worker.ready" }));
    await grantPendingSigner(harness, secondSocket);

    await waitFor(() => expect(secondSocket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      streamId: "33333333-3333-4333-8333-333333333333",
      sequence: 0,
      action: "start"
    })));
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(screen.getByText(/connection recovered/i)).toBeVisible();

    act(() => firstWorker.emit({
      type: "frame.result",
      requestId: 99,
      timestampMs: 4_000,
      result: { kind: "accepted", frameKind: "active", features: activeChunkFixture.frames[0].features },
      gestureCandidate: completedGestureCandidate(2_000)
    }));
    expect(firstSocket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(0);
    await emitCompletedGesture(harness, secondWorker);
    const restartedChunks = secondSocket.parsedSent().filter((event) => event.type === "landmark.chunk");
    expect(restartedChunks).toHaveLength(6);
    expect(restartedChunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(restartedChunks.flatMap((chunk) => chunk.frames as Array<Record<string, unknown>>)
      .map((frame) => frame.sequence)).toEqual(Array.from({ length: 30 }, (_unused, index) => index));

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
    expect(socket.parsedSent().filter((event) => event.type === "recognition.control"
      || event.type === "landmark.chunk")).toHaveLength(0);
    const worker = FakeWorker.instances[0];
    act(() => worker.emit({ type: "worker.ready" }));
    await grantPendingSigner(harness, socket);
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
    expect(screen.getByLabelText("Recognition service status")).toHaveTextContent(/timed out|temporarily unavailable/i);
    act(() => socket.message({
      ...readyFixture,
      payload: { ...readyFixture.payload, reason: "RECOVERED", message: "Recognition is available again." }
    }));
    expect(screen.getByLabelText("Recognition service status")).toHaveTextContent(/available again|recovered/i);
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

    await screen.findByLabelText("Meeting error");
    expect(screen.getByLabelText("Meeting error")).toHaveTextContent(/camera.*disconnected|permission.*revoked/i);
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
    expect(screen.queryByLabelText("Meeting error")).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("Recognition service status"))
      .toHaveTextContent(/^Recognition stopped\.$/i);

    await harness.user.click(screen.getByRole("button", { name: "Start recognition" }));
    const nextWorker = FakeWorker.instances[1];
    act(() => nextWorker.emit({ type: "worker.ready" }));
    await grantPendingSigner(harness, socket);
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
    expect(screen.getByLabelText("Recognition service status"))
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
    expect(screen.getByLabelText("Recognition service status"))
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
        json: async () => meetingSession
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
      secondRequest.resolve({ ok: true, json: async () => meetingSession } as Response);
      await secondRequest.promise;
      await Promise.resolve();
    });
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(createSocket).toHaveBeenLastCalledWith(expect.stringContaining(meeting.id));

    const staleMeetingSession = {
      ...meetingSession,
      meeting: {
        ...meeting,
        id: "55555555-5555-4555-8555-555555555555"
      }
    };
    await act(async () => {
      firstRequest.resolve({ ok: true, json: async () => staleMeetingSession } as Response);
      await firstRequest.promise;
      await Promise.resolve();
    });

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`Room ${meeting.joinCode}`)).toBeVisible();
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

    const announcement = screen.getByRole("status", { name: "Meeting announcements" });
    await waitFor(() => expect(announcement).toHaveTextContent(/no hands detected/i));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });

  it("keeps every capture status accessible without duplicating live announcements", async () => {
    const harness = makeHarness();
    const expectAccessibleStatus = (text: RegExp) => {
      const statusText = screen.getByText(text);
      expect(statusText.closest("[aria-hidden='true']")).toBeNull();
    };

    expectAccessibleStatus(/^Recognition stopped\.$/i);
    await enableCamera(harness);
    const socket = await connectSession(harness);
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
    await grantPendingSigner(harness, socket);
    await waitFor(() => expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "recognition.control",
      action: "start"
    })));

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

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Meeting announcements" })).toHaveTextContent(/recognition model unavailable/i);
  });
});
