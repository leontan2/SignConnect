import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import activeChunkFixture from "../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import captionFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import readyFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-ready.valid.json";
import unavailableFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-unavailable.valid.json";
import unknownFixture from "../../../../contracts/sign-recognition/v1/fixtures/server-recognition-unknown.valid.json";
import roomNotFoundFixture from "../../../../contracts/realtime-room/v1/fixtures/server-room-error-room-not-found.valid.json";
import MeetingApp, * as meetingModule from "./MeetingApp";
import type { PeerConnectionLike } from "./call/PeerCallController";

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
  enabled = true;
  readonly stop = vi.fn();
  private readonly endedListeners = new Set<EventListenerOrEventListenerObject>();

  constructor(readonly kind: "audio" | "video" = "video") {}

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

function makeHarness(options: {
  recognitionResponseTimeoutMs?: number;
  roomPreviewToolsEnabled?: boolean;
  speechRecognitionFactory?: (handlers: {
    onStart(): void;
    onFinalTranscript(text: string): void;
    onError(reason: string): void;
    onEnd(): void;
  }) => { start(): void; stop(): void } | null;
  peerConnectionFactory?: (configuration: RTCConfiguration) => PeerConnectionLike;
  callIdFactory?: () => string;
  mediaStreamFactory?: (tracks: MediaStreamTrack[]) => MediaStream;
} = {}): Harness {
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
    trackingAnnouncementDelayMs: 20,
    recognitionResponseTimeoutMs: options.recognitionResponseTimeoutMs,
    roomPreviewToolsEnabled: options.roomPreviewToolsEnabled,
    speechRecognitionFactory: options.speechRecognitionFactory,
    peerConnectionFactory: options.peerConnectionFactory,
    callIdFactory: options.callIdFactory,
    mediaStreamFactory: options.mediaStreamFactory
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
    await waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
    expect(FakeWorker.instances[0].posted.map(({ type }) => type)).toEqual(["worker.initialize"]);
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

  it("keeps browser-local generic gesture labels out of the sign-recognition experience", async () => {
    const harness = makeHarness();
    expect(screen.queryByText(/generic gesture preview/i)).not.toBeInTheDocument();

    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "active", {
      timestampMs: harness.clock.value,
      gestureModel: "ready",
      hands: [],
      upperBody: [],
      gesture: {
        source: "mediapipe-canned-gestures",
        label: "Open_Palm",
        displayName: "Open palm",
        confidence: 0.99,
        handedness: "Right",
        stable: true,
        consecutiveFrames: 4
      },
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

    expect(screen.queryByText("Open palm")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Camera readiness")).getByText("Ready to sign")).toBeVisible();
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
      ["no-person", "No person detected", "Sit or stand naturally in the center of the camera guide."],
      ["upper-body-missing", "Upper body not fully visible", "Move back until both shoulders are visible."],
      ["left-hand-missing", "Left hand missing", "Bring your left hand into the camera guide."],
      ["right-hand-missing", "Right hand missing", "Bring your right hand into the camera guide."],
      ["out-of-frame", "Hands too close to the frame edge", "Move your signing hand or hands away from the edge of the guide."],
      ["low-quality", "Lighting or tracking quality too poor", "Face the camera, improve lighting, and keep your upper body steady."]
    ] as const;
    for (const [state, label, message] of states) {
      await emitAcceptedFrame(harness, worker, state === "no-person" ? "idle" : "active", {
        timestampMs: harness.clock.value,
        hands: state === "upper-body-missing"
          ? [{ handedness: "Right", score: 0.96, points: [{ index: 0, x: 0.5, y: 0.5 }] }]
          : [],
        upperBody: [],
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
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(message);
      if (state === "upper-body-missing") {
        expect(screen.getByText("1 hand tracked")).toBeVisible();
      }
    }

    await emitAcceptedFrame(harness, worker, "active", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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
      hands: [],
      upperBody: [],
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
      hands: [],
      upperBody: [],
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
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Ready to sign/);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(
      "Both shoulders and at least one signing hand are visible and calibrated."
    );
    await emitCompletedGesture(harness, worker);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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
    await emitCompletedGesture(harness, worker);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    act(() => socket.message(captionFixture));
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/sign recognized/i);
    expect(screen.queryAllByRole("article")).toHaveLength(1);
  });

  it("keeps a dispatched gesture processing until its result settles, then returns to ready", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    const readyFrame = {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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
    };

    await emitAcceptedFrame(harness, worker, "idle", readyFrame);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Ready to sign/);

    await emitCompletedGesture(harness, worker);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);

    await emitAcceptedFrame(harness, worker, "idle", {
      ...readyFrame,
      timestampMs: harness.clock.value
    });
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);

    act(() => socket.message({
      ...captionFixture,
      streamId: "33333333-3333-4333-8333-333333333333",
      participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      captionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sequence: ++harness.roomSequence.value,
      payload: { ...captionFixture.payload, sourceDisplayName: "Ari" }
    }));
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    expect(screen.queryByLabelText("Latest recognized sign")).not.toBeInTheDocument();

    vi.useFakeTimers();
    try {
      act(() => socket.message(captionFixture));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Sign recognized/);
      const latestSign = screen.getByLabelText("Latest recognized sign");
      expect(within(latestSign).getByText(captionFixture.payload.text)).toBeVisible();
      expect(within(latestSign).getByText(/you signed/i)).toBeVisible();

      act(() => vi.advanceTimersByTime(1_999));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Sign recognized/);

      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Ready to sign/);
      expect(screen.getByLabelText("Latest recognized sign")).toHaveTextContent(
        captionFixture.payload.text
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears confirmed signs and the persistent latest-sign result from the live transcript", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);

    await emitCompletedGesture(harness, worker);
    act(() => socket.message(captionFixture));
    expect(screen.getByRole("region", { name: "Live transcript" }).getElementsByClassName("caption-entry")).toHaveLength(1);
    expect(screen.getByLabelText("Latest recognized sign")).toBeVisible();

    await harness.user.click(screen.getByRole("button", { name: "Clear transcript" }));

    expect(screen.getByText("No transcript entries yet")).toBeVisible();
    expect(screen.getByLabelText("0 transcript entries")).toBeVisible();
    expect(screen.queryByLabelText("Latest recognized sign")).not.toBeInTheDocument();
  });

  it("captures final microphone speech as a locally labelled transcript entry", async () => {
    let speechHandlers: {
      onStart(): void;
      onFinalTranscript(text: string): void;
      onError(reason: string): void;
      onEnd(): void;
    } | null = null;
    const speechController = { start: vi.fn(), stop: vi.fn() };
    const harness = makeHarness({
      speechRecognitionFactory: (handlers) => {
        speechHandlers = handlers;
        return speechController;
      }
    });
    await connectSession(harness);

    await harness.user.click(screen.getByRole("button", { name: "Start spoken transcript" }));
    expect(speechController.start).toHaveBeenCalledOnce();
    act(() => speechHandlers?.onStart());
    expect(screen.getByText("Listening to your microphone")).toBeVisible();

    act(() => speechHandlers?.onFinalTranscript("Let us review the next item."));
    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getByText("Let us review the next item.")).toBeVisible();
    expect(within(transcript).getByText("You spoke")).toBeVisible();
    expect(within(transcript).getByText("Local microphone")).toBeVisible();

    await harness.user.click(screen.getByRole("button", { name: "Stop spoken transcript" }));
    expect(speechController.stop).toHaveBeenCalledOnce();
  });

  it("sends a typed room message and renders the server-attributed echo exactly once", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    const composer = screen.getByLabelText("Message the room");

    await harness.user.type(composer, "Can you repeat that sign?");
    await harness.user.click(screen.getByRole("button", { name: "Send message" }));

    const command = socket.parsedSent().find((event) => event.type === "chat.message");
    expect(command).toEqual({
      schemaVersion: 1,
      type: "chat.message",
      messageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      text: "Can you repeat that sign?"
    });
    expect(composer).toHaveValue("");

    const echoed = {
      schemaVersion: 1,
      type: "chat.message",
      meetingId: meeting.id,
      participantId: meetingSession.participant.id,
      messageId: command?.messageId,
      sequence: ++harness.roomSequence.value,
      payload: {
        text: "Can you repeat that sign?",
        sourceDisplayName: "You"
      },
      occurredAt: "2026-01-01T00:00:03Z"
    };
    act(() => socket.message(echoed));
    act(() => socket.message(echoed));

    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getByText("Can you repeat that sign?")).toBeVisible();
    expect(within(transcript).getByText("You typed")).toBeVisible();
    expect(within(transcript).getAllByRole("article")).toHaveLength(1);
  });

  it("places the room composer after history and visibly identifies different participants", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    const transcript = screen.getByRole("region", { name: "Live transcript" });
    const conversationHistory = within(transcript).getByLabelText("Conversation history");
    const composer = within(transcript).getByLabelText("Message the room").closest("form");

    expect(composer).not.toBeNull();
    expect(conversationHistory.compareDocumentPosition(composer!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    act(() => socket.message({
      schemaVersion: 1,
      type: "chat.message",
      meetingId: meeting.id,
      participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      messageId: "11111111-1111-4111-8111-111111111111",
      sequence: ++harness.roomSequence.value,
      payload: { text: "Could you repeat that?", sourceDisplayName: "Aisyah Rahman" },
      occurredAt: "2026-01-01T00:00:03Z"
    }));
    act(() => socket.message({
      schemaVersion: 1,
      type: "chat.message",
      meetingId: meeting.id,
      participantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      messageId: "22222222-2222-4222-8222-222222222222",
      sequence: ++harness.roomSequence.value,
      payload: { text: "Yes, one moment.", sourceDisplayName: "Marcus Lee" },
      occurredAt: "2026-01-01T00:00:04Z"
    }));

    const aisyahEntry = within(transcript).getByLabelText(/Aisyah Rahman typed Could you repeat that/);
    const marcusEntry = within(transcript).getByLabelText(/Marcus Lee typed Yes, one moment/);
    expect(within(aisyahEntry).getByText("AR")).toBeVisible();
    expect(within(marcusEntry).getByText("ML")).toBeVisible();
    expect(aisyahEntry).not.toHaveAttribute("data-participant-tone", marcusEntry.getAttribute("data-participant-tone"));
  });

  it("follows new transcript entries unless the user is reading older messages", async () => {
    const harness = makeHarness();
    const socket = await connectSession(harness);
    const history = screen.getByLabelText("Conversation history");
    const scrollTo = vi.fn();
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, writable: true, value: 700 },
      scrollTo: { configurable: true, value: scrollTo }
    });
    fireEvent.scroll(history);

    act(() => socket.message({
      schemaVersion: 1,
      type: "chat.message",
      meetingId: meeting.id,
      participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      messageId: "33333333-3333-4333-8333-333333333333",
      sequence: ++harness.roomSequence.value,
      payload: { text: "First new message", sourceDisplayName: "Aisyah Rahman" },
      occurredAt: "2026-01-01T00:00:03Z"
    }));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" }));

    scrollTo.mockClear();
    Object.defineProperty(history, "scrollTop", { configurable: true, writable: true, value: 100 });
    fireEvent.scroll(history);
    act(() => socket.message({
      schemaVersion: 1,
      type: "chat.message",
      meetingId: meeting.id,
      participantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      messageId: "44444444-4444-4444-8444-444444444444",
      sequence: ++harness.roomSequence.value,
      payload: { text: "Second new message", sourceDisplayName: "Marcus Lee" },
      occurredAt: "2026-01-01T00:00:04Z"
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    const jumpToLatest = await screen.findByRole("button", { name: "1 new message. Jump to latest" });
    await harness.user.click(jumpToLatest);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "smooth" });
    expect(history).toHaveFocus();
  });

  it("starts a private call with the existing camera track and provides mute and end controls", async () => {
    const connection = {
      connectionState: "new",
      onconnectionstatechange: null,
      onicecandidate: null,
      ontrack: null,
      addTrack: vi.fn(),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=host" })),
      createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0\r\no=guest" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined),
      addIceCandidate: vi.fn(async () => undefined),
      close: vi.fn()
    } as unknown as PeerConnectionLike;
    const callIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ];
    const combinedStreams: MediaStream[] = [];
    const harness = makeHarness({
      peerConnectionFactory: () => connection,
      callIdFactory: () => callIds.shift()!,
      mediaStreamFactory: (tracks) => {
        const stream = {
          getTracks: () => tracks,
          getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
          getAudioTracks: () => tracks.filter((track) => track.kind === "audio")
        } as unknown as MediaStream;
        combinedStreams.push(stream);
        return stream;
      }
    });
    const videoTrack = new FakeMediaTrack("video") as unknown as MediaStreamTrack;
    const fakeAudioTrack = new FakeMediaTrack("audio");
    const audioTrack = fakeAudioTrack as unknown as MediaStreamTrack;
    const cameraStream = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => []
    } as unknown as MediaStream;
    const microphoneStream = {
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack]
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => constraints.video
      ? cameraStream
      : microphoneStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia }
    });

    const socket = await connectSession(harness);
    act(() => socket.message({
      schemaVersion: 1,
      type: "room.snapshot",
      meetingId: meeting.id,
      sequence: ++harness.roomSequence.value,
      payload: {
        participants: [
          { participantId: meetingSession.participant.id, displayName: "You", role: "HOST" },
          { participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Ari", role: "GUEST" }
        ]
      },
      occurredAt: meeting.createdAt
    }));
    await enableCamera(harness);

    const startCall = await screen.findByRole("button", { name: "Start call" });
    expect(startCall).toBeEnabled();
    await harness.user.click(startCall);

    await waitFor(() => expect(socket.parsedSent()).toContainEqual({
      schemaVersion: 1,
      type: "call.offer",
      signalId: "22222222-2222-4222-8222-222222222222",
      callId: "11111111-1111-4111-8111-111111111111",
      targetParticipantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: { sdp: "v=0\r\no=host" }
    }));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: false, audio: true });
    expect(connection.addTrack).toHaveBeenCalledWith(videoTrack, combinedStreams[0]);
    expect(connection.addTrack).toHaveBeenCalledWith(audioTrack, combinedStreams[0]);
    expect(fakeAudioTrack.endedListenerCount).toBe(1);

    await harness.user.click(screen.getByRole("button", { name: "Mute call microphone" }));
    expect(audioTrack.enabled).toBe(false);
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "media.state",
      payload: { audioEnabled: false, videoEnabled: true }
    }));

    await harness.user.click(screen.getByRole("button", { name: "End call" }));
    expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
      type: "call.leave",
      payload: { reason: "user_left" }
    }));
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(fakeAudioTrack.endedListenerCount).toBe(0);
    expect(videoTrack.stop).not.toHaveBeenCalled();
  });

  it("adds and removes local preview participants without sending room events", async () => {
    const harness = makeHarness({ roomPreviewToolsEnabled: true });
    const socket = await connectSession(harness);
    const sentBeforePreview = socket.sent.length;

    await harness.user.click(screen.getByRole("button", { name: "Add demo participant" }));

    const people = screen.getByRole("list", { name: "People in this room" });
    expect(within(people).getByText("Aisyah Rahman")).toBeVisible();
    expect(within(people).getByText("Demo")).toBeVisible();
    expect(screen.getByText("2 participants")).toBeVisible();
    expect(screen.getByRole("region", { name: "Live transcript" })).toHaveTextContent(
      "Could we repeat the last point?"
    );
    expect(socket.sent).toHaveLength(sentBeforePreview);

    await harness.user.click(screen.getByRole("button", { name: "Remove demo participants" }));
    expect(within(people).queryByText("Aisyah Rahman")).not.toBeInTheDocument();
    expect(screen.getByText("1 participant")).toBeVisible();
  });

  it("stops recognition and explains recovery when a gesture result never arrives", async () => {
    const harness = makeHarness({ recognitionResponseTimeoutMs: 100 });
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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

    vi.useFakeTimers();
    try {
      await emitCompletedGesture(harness, worker);
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
      act(() => vi.advanceTimersByTime(100));

      expect(screen.getByLabelText("Camera readiness")).not.toHaveTextContent(/^Processing/);
      expect(document.querySelector(".recognition-feedback")).toHaveTextContent(
        /recognition timed out before returning a result/i
      );
      expect(screen.getByRole("button", { name: "Start recognition" })).toBeEnabled();
      expect(socket.parsedSent()).toContainEqual(expect.objectContaining({
        type: "recognition.control",
        action: "stop"
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes completed gestures until the frozen v1 result settles", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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

    await emitCompletedGesture(harness, worker);
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(6);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);

    await emitCompletedGesture(harness, worker);
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(6);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);

    act(() => socket.message(unknownFixture));
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Sign not recognized/);
    act(() => socket.message(captionFixture));
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    await emitCompletedGesture(harness, worker);
    expect(socket.parsedSent().filter((event) => event.type === "landmark.chunk")).toHaveLength(12);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    expect(document.querySelector(".recognition-feedback")).not.toBeInTheDocument();
  });

  it("expires unknown feedback before the next gesture is dispatched", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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
    await emitCompletedGesture(harness, worker);

    vi.useFakeTimers();
    try {
      act(() => socket.message(unknownFixture));
      expect(document.querySelector(".recognition-feedback")).toHaveTextContent(
        /sign was not recognized with enough confidence/i
      );

      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Ready to sign/);
      expect(document.querySelector(".recognition-feedback")).not.toBeInTheDocument();

      await emitCompletedGesture(harness, worker);
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
      expect(document.querySelector(".recognition-feedback")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a settled result when a new gesture starts and clears processing on failure or stop", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    const worker = await startRecognition(harness, socket);
    await emitAcceptedFrame(harness, worker, "idle", {
      timestampMs: harness.clock.value,
      hands: [],
      upperBody: [],
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
    await emitCompletedGesture(harness, worker);

    vi.useFakeTimers();
    try {
      act(() => socket.message(unknownFixture));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Sign not recognized/);
      act(() => vi.advanceTimersByTime(1_000));

      await emitCompletedGesture(harness, worker);
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);

      act(() => socket.message(unavailableFixture));
      expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Ready to sign/);
    } finally {
      vi.useRealTimers();
    }

    await emitCompletedGesture(harness, worker);
    expect(screen.getByLabelText("Camera readiness")).toHaveTextContent(/^Processing/);
    await harness.user.click(screen.getByRole("button", { name: "Stop recognition" }));
    expect(screen.getByLabelText("Camera readiness")).not.toHaveTextContent(/^Processing/);
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
    expect(within(transcript).getByText("Ari signed")).toBeVisible();
    const signedAt = within(transcript).getByText(/^at /i);
    expect(signedAt).toHaveAttribute("datetime", roomCaption.occurredAt);
    expect(signedAt.textContent).toMatch(/:\d{2}/);
    expect(within(transcript).getByText("95% confidence")).toBeVisible();
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
    expect(within(screen.getByRole("region", { name: "Live transcript" }))
      .getByText("Synthetic active gesture")).toBeVisible();
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
    const worker = await startRecognition(harness, socket);

    await emitCompletedGesture(harness, worker);
    act(() => socket.message(unknownFixture));
    expect(document.querySelector(".recognition-feedback")).toHaveTextContent(/sign was not recognized/i);

    await emitCompletedGesture(harness, worker);

    act(() => {
      socket.message({
        ...captionFixture,
        participantId: meetingSession.participant.id,
        captionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sequence: ++harness.roomSequence.value,
        payload: {
          ...captionFixture.payload,
          sourceDisplayName: "You"
        }
      });
      socket.message(readyFixture);
      socket.message({ ...captionFixture, type: "caption.partial" });
      socket.messageRaw("{malformed");
    });

    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getByText("Synthetic active gesture")).toBeVisible();
    expect(within(transcript).getAllByRole("article")).toHaveLength(1);
    expect(within(transcript).getByText("You signed")).toBeVisible();
    expect(within(transcript).queryByText("You (you) signed")).not.toBeInTheDocument();
    expect(within(transcript).getByText(/synthetic-v1/i)).toBeVisible();
    expect(within(transcript).getByRole("note")).toHaveTextContent(/mock integration model/i);
    expect(screen.getByText(/unsupported realtime event was ignored/i)).toBeVisible();
  });

  it("labels the local ASL research model without showing the synthetic-model warning", async () => {
    const harness = makeHarness();
    await enableCamera(harness);
    const socket = await connectSession(harness);
    await startRecognition(harness, socket);

    act(() => socket.message({
      ...readyFixture,
      payload: {
        ...readyFixture.payload,
        modelVersion: "asl-wlasl-slgcn-core-v2",
        mockModel: false
      }
    }));

    const transcript = screen.getByRole("region", { name: "Live transcript" });
    expect(within(transcript).getByRole("note")).toHaveTextContent(/local ASL research model/i);
    expect(within(transcript).getByRole("note")).toHaveTextContent(/Hello.*Thank you.*Goodbye/i);
    expect(within(transcript).queryByText(/mock integration model/i)).not.toBeInTheDocument();
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
    act(() => socket.message(unknownFixture));
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
    expect(within(screen.getByRole("region", { name: "Live transcript" }))
      .getByText("Synthetic active gesture")).toBeVisible();
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
