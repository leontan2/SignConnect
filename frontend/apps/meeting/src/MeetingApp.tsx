import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Activity,
  Captions,
  Check,
  CircleAlert,
  CircleHelp,
  Copy,
  Hand,
  LoaderCircle,
  LogIn,
  Mic,
  MicOff,
  MessageSquare,
  Phone,
  PhoneOff,
  Plus,
  Radio,
  ScanLine,
  Send,
  Square,
  Trash2,
  UserPlus,
  Users,
  Video,
  VideoOff
} from "lucide-react";

import {
  createMeeting,
  joinMeeting,
  MeetingRequestError,
  type CaptionEvent,
  type CallSignalCommand,
  type CallSignalEvent,
  type ChatMessageEvent,
  type Meeting,
  type Participant,
  type RoomParticipant,
  type ServerRealtimeEvent,
  type SignerReleaseEvent
} from "./api";
import {
  PeerCallController,
  type PeerCallState,
  type PeerConnectionLike
} from "./call/PeerCallController";
import {
  type RealtimeRetryScheduler,
  type RealtimeSocketLike
} from "./recognition/RealtimeClient";
import type { BrowserLocalVisionFrame, LandmarkCaptureStatus } from "./recognition/contracts";
import {
  mapCanonicalApplicationState,
  type CanonicalApplicationState
} from "./recognition/CanonicalStateMapper";
import {
  observeCanvasBackingStore,
  synchronizeCanvasBackingStore
} from "./recognition/overlayCanvas";
import type { UseLandmarkCaptureOptions } from "./recognition/useLandmarkCapture";
import { useRealtimeSession } from "./recognition/useRealtimeSession";
import RecognitionSimulator from "./recognition/RecognitionSimulator";
import {
  captureStatusText,
  type RecognitionClock,
  useSignRecognition
} from "./recognition/useSignRecognition";
import {
  createBrowserSpeechRecognition,
  type SpeechRecognitionController,
  type SpeechRecognitionFactory
} from "./speechTranscript";
import { ToastViewport, useToastQueue } from "./ToastViewport";
import "./meeting.css";

type CameraState = "off" | "requesting" | "on" | "permission-denied" | "no-device" | "error";

type ProductState = {
  captions: CaptionEvent[];
  latestLocalCaption: CaptionEvent | null;
  pendingRecognitionStreamId: string | null;
  latestRecognitionOutcome: "recognized" | "not-recognized" | null;
  latestRecognitionStreamId: string | null;
  recognitionResultToken: number;
  recognitionFeedback: string | null;
  serviceStatus: string;
  protocolFeedback: string | null;
  signerFeedback: string | null;
  mockModelActive: boolean;
  activeModelVersion: string | null;
};

type ProductAction =
  | { type: "server-event"; event: ServerRealtimeEvent }
  | { type: "parse-issue"; reason: "malformed" | "unsupported" }
  | { type: "room-order-issue" }
  | { type: "gesture-dispatched"; streamId: string }
  | { type: "recognition-ended"; streamId: string }
  | { type: "recognition-timeout"; streamId: string }
  | { type: "recognition-result-expired"; token: number }
  | { type: "signer-feedback"; message: string | null }
  | { type: "clear-transcript" }
  | { type: "reset-session" };

const INITIAL_PRODUCT_STATE: ProductState = {
  captions: [],
  latestLocalCaption: null,
  pendingRecognitionStreamId: null,
  latestRecognitionOutcome: null,
  latestRecognitionStreamId: null,
  recognitionResultToken: 0,
  recognitionFeedback: null,
  serviceStatus: "Recognition service is waiting.",
  protocolFeedback: null,
  signerFeedback: null,
  mockModelActive: false,
  activeModelVersion: null
};

const SIMULATOR_ENABLED = process.env.RECOGNITION_SIMULATOR_ENABLED === "true";
const ROOM_PREVIEW_TOOLS_ENABLED = typeof process !== "undefined"
  && process.env.ROOM_PREVIEW_TOOLS_ENABLED === "true";
const LOCAL_ROOM_PREVIEW_ENABLED = typeof window !== "undefined"
  && ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
const RECOGNITION_RESULT_DWELL_MS = 2_000;
const RECOGNITION_RESPONSE_TIMEOUT_MS = 5_000;

function productReducer(state: ProductState, action: ProductAction): ProductState {
  if (action.type === "reset-session") return { ...INITIAL_PRODUCT_STATE };
  if (action.type === "clear-transcript") {
    return {
      ...state,
      captions: [],
      latestLocalCaption: null,
      latestRecognitionOutcome: null,
      latestRecognitionStreamId: null,
      recognitionFeedback: null
    };
  }
  if (action.type === "room-order-issue") {
    return { ...state, protocolFeedback: "Some room updates arrived out of order. The newest room state is shown." };
  }
  if (action.type === "gesture-dispatched") {
    return {
      ...state,
      pendingRecognitionStreamId: action.streamId,
      latestRecognitionOutcome: null,
      latestRecognitionStreamId: null,
      recognitionFeedback: null
    };
  }
  if (action.type === "recognition-ended") {
    if (state.pendingRecognitionStreamId !== action.streamId
      && state.latestRecognitionStreamId !== action.streamId) return state;
    return {
      ...state,
      pendingRecognitionStreamId: null,
      latestRecognitionOutcome: null,
      latestRecognitionStreamId: null,
      recognitionFeedback: null
    };
  }
  if (action.type === "recognition-timeout") {
    if (state.pendingRecognitionStreamId !== action.streamId) return state;
    return {
      ...state,
      pendingRecognitionStreamId: null,
      latestRecognitionOutcome: null,
      latestRecognitionStreamId: null,
      recognitionFeedback: "Recognition timed out before returning a result. Start recognition and try the sign again.",
      serviceStatus: "Recognition result timed out."
    };
  }
  if (action.type === "recognition-result-expired") {
    if (state.recognitionResultToken !== action.token) return state;
    return {
      ...state,
      latestRecognitionOutcome: null,
      latestRecognitionStreamId: null,
      recognitionFeedback: null
    };
  }
  if (action.type === "signer-feedback") return { ...state, signerFeedback: action.message };
  if (action.type === "parse-issue") {
    const protocolFeedback = action.reason === "unsupported"
      ? "Unsupported realtime event was ignored."
      : state.protocolFeedback ?? "Malformed realtime event was ignored.";
    return { ...state, protocolFeedback };
  }

  const event = action.event;
  if (event.type === "caption.final") {
    if (event.captionId && state.captions.some((caption) => caption.captionId === event.captionId)) {
      return state;
    }
    const matchesPendingRecognition = event.streamId === state.pendingRecognitionStreamId;
    if (!matchesPendingRecognition && event.participantId === undefined) {
      return state;
    }
    return {
      ...state,
      captions: [...state.captions, event],
      latestLocalCaption: matchesPendingRecognition ? event : state.latestLocalCaption,
      pendingRecognitionStreamId: matchesPendingRecognition ? null : state.pendingRecognitionStreamId,
      latestRecognitionOutcome: matchesPendingRecognition ? "recognized" : state.latestRecognitionOutcome,
      latestRecognitionStreamId: matchesPendingRecognition ? event.streamId : state.latestRecognitionStreamId,
      recognitionResultToken: matchesPendingRecognition
        ? state.recognitionResultToken + 1
        : state.recognitionResultToken,
      recognitionFeedback: null,
      mockModelActive: state.mockModelActive || event.payload.mockModel,
      activeModelVersion: event.payload.modelVersion
    };
  }
  if (event.type === "recognition.unknown") {
    const reason = event.payload.reason === "LOW_CONFIDENCE"
      ? "The sign was not recognized with enough confidence."
      : "The sign was not recognized because tracking was unstable.";
    const matchesPendingRecognition = event.streamId === state.pendingRecognitionStreamId;
    if (!matchesPendingRecognition) {
      return event.payload.mockModel && !state.mockModelActive
        ? { ...state, mockModelActive: true, activeModelVersion: event.payload.modelVersion }
        : state;
    }
    return {
      ...state,
      recognitionFeedback: reason,
      pendingRecognitionStreamId: matchesPendingRecognition ? null : state.pendingRecognitionStreamId,
      latestRecognitionOutcome: matchesPendingRecognition ? "not-recognized" : state.latestRecognitionOutcome,
      latestRecognitionStreamId: matchesPendingRecognition ? event.streamId : state.latestRecognitionStreamId,
      recognitionResultToken: matchesPendingRecognition
        ? state.recognitionResultToken + 1
        : state.recognitionResultToken,
      mockModelActive: state.mockModelActive || event.payload.mockModel,
      activeModelVersion: event.payload.modelVersion
    };
  }

  if (event.type !== "recognition.status") return state;

  let serviceStatus = event.payload.message;
  if (event.payload.state === "UNAVAILABLE" && event.payload.reason === "TIMEOUT") {
    serviceStatus = "Recognition inference timed out and is temporarily unavailable.";
  } else if (event.payload.state === "UNAVAILABLE") {
    serviceStatus = "Recognition inference is temporarily unavailable.";
  } else if (event.payload.reason === "RECOVERED") {
    serviceStatus = "Recognition is available again; service recovered.";
  } else if (event.payload.state === "STOPPED") {
    serviceStatus = "Recognition stopped.";
  }
  const recognitionFailed = event.payload.state === "UNAVAILABLE"
    || event.payload.state === "INVALID_INPUT"
    || event.payload.state === "STOPPED";
  const matchesPendingRecognition = event.streamId === state.pendingRecognitionStreamId;
  const matchesRecognitionResult = event.streamId === state.latestRecognitionStreamId;
  return {
    ...state,
    pendingRecognitionStreamId: recognitionFailed && matchesPendingRecognition
      ? null
      : state.pendingRecognitionStreamId,
    latestRecognitionOutcome: recognitionFailed && (matchesPendingRecognition || matchesRecognitionResult)
      ? null
      : state.latestRecognitionOutcome,
    latestRecognitionStreamId: recognitionFailed && matchesRecognitionResult
      ? null
      : state.latestRecognitionStreamId,
    recognitionFeedback: recognitionFailed && (matchesPendingRecognition || matchesRecognitionResult)
      ? null
      : state.recognitionFeedback,
    serviceStatus,
    mockModelActive: state.mockModelActive || event.payload.mockModel === true,
    activeModelVersion: event.payload.modelVersion ?? state.activeModelVersion
  };
}

export interface MeetingAppComposition {
  socketFactory?: (url: string) => RealtimeSocketLike;
  retryScheduler?: RealtimeRetryScheduler;
  maximumBufferedAmount?: number;
  captureOptions?: Omit<UseLandmarkCaptureOptions, "onStatus" | "onGestureCandidate">;
  clock?: RecognitionClock;
  trackingAnnouncementDelayMs?: number;
  recognitionResponseTimeoutMs?: number;
  requestIdFactory?: () => string;
  roomPreviewToolsEnabled?: boolean;
  speechRecognitionFactory?: SpeechRecognitionFactory;
  messageIdFactory?: () => string;
  callIdFactory?: () => string;
  peerConnectionFactory?: (configuration: RTCConfiguration) => PeerConnectionLike;
  mediaStreamFactory?: (tracks: MediaStreamTrack[]) => MediaStream;
}

type IncomingCallOffer = Extract<CallSignalEvent, { type: "call.offer" }>;

type SpokenTranscriptEntry = {
  id: string;
  sourceDisplayName: string;
  text: string;
  occurredAt: string;
  simulated?: boolean;
};

type SpeechCaptureStatus = "idle" | "starting" | "listening" | "unsupported" | "permission-denied" | "error";

type DemoParticipant = RoomParticipant & {
  simulated: true;
};

const DEMO_PARTICIPANTS: ReadonlyArray<{
  participant: DemoParticipant;
  sampleSpeech: string;
}> = [
  {
    participant: {
      participantId: "d0000000-0000-4000-8000-000000000001",
      displayName: "Aisyah Rahman",
      role: "GUEST",
      activeSigner: false,
      simulated: true
    },
    sampleSpeech: "Could we repeat the last point?"
  },
  {
    participant: {
      participantId: "d0000000-0000-4000-8000-000000000002",
      displayName: "Daniel Tan",
      role: "GUEST",
      activeSigner: true,
      simulated: true
    },
    sampleSpeech: "Yes, I understand."
  },
  {
    participant: {
      participantId: "d0000000-0000-4000-8000-000000000003",
      displayName: "Priya Nair",
      role: "GUEST",
      activeSigner: false,
      simulated: true
    },
    sampleSpeech: "Thank you."
  }
];

function cameraFailure(error: unknown): { state: CameraState; message: string } {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return { state: "no-device", message: "No camera device was found." };
  }
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return { state: "permission-denied", message: "Camera permission was not granted." };
  }
  return { state: "error", message: "The camera could not be started." };
}

function tracksOfKind(stream: MediaStream | null, kind: "audio" | "video"): MediaStreamTrack[] {
  if (!stream) return [];
  const getter = kind === "video" ? stream.getVideoTracks : stream.getAudioTracks;
  if (typeof getter === "function") return getter.call(stream);
  return stream.getTracks().filter((track) => track.kind === kind);
}

function recognitionDisabledReason(cameraState: CameraState, connected: boolean): string {
  if (cameraState !== "on" && !connected) {
    return "Turn on the camera and start a session before recognition.";
  }
  if (cameraState !== "on") return "Turn on the camera before recognition.";
  if (!connected) return "Start a session before recognition.";
  return "Recognition is ready to start.";
}

type CameraReadinessGuidance = {
  title: CanonicalApplicationState;
  message: string;
};

function cameraReadinessGuidance(
  cameraState: CameraState,
  recognitionEnabled: boolean,
  frame: BrowserLocalVisionFrame | null,
  recognitionPending: boolean,
  recognitionOutcome: ProductState["latestRecognitionOutcome"]
): CameraReadinessGuidance {
  const title = mapCanonicalApplicationState({
    camera: cameraState === "requesting" ? "initializing" : cameraState === "on" ? "on" : "off",
    recognitionEnabled,
    hasFrame: frame !== null,
    trackingQuality: frame?.trackingQuality.state ?? null,
    calibrationReady: frame?.calibration.state === "ready",
    gesturePhase: frame?.gesturePhase ?? null,
    recognitionPending,
    recognitionOutcome
  });
  switch (title) {
    case "Camera off":
      return { title, message: "Turn on the camera to position yourself before recognition." };
    case "Camera initializing":
      return { title, message: cameraState === "requesting"
        ? "Approve camera access, then keep your upper body in view."
        : recognitionEnabled
          ? "Keep both shoulders and your signing hand or hands inside the guide while positioning completes."
          : "Start recognition when you are ready to check positioning." };
    case "No person detected":
      return { title, message: "Sit or stand naturally in the center of the camera guide." };
    case "Upper body not fully visible":
      return { title, message: "Move back until both shoulders are visible." };
    case "Left hand missing":
      return { title, message: "Bring your left hand into the camera guide." };
    case "Right hand missing":
      return { title, message: "Bring your right hand into the camera guide." };
    case "Hands too close to the frame edge":
      return { title, message: "Move your signing hand or hands away from the edge of the guide." };
    case "Lighting or tracking quality too poor":
      return { title, message: "Face the camera, improve lighting, and keep your upper body steady." };
    case "Gesture in progress":
      return { title, message: "Continue naturally until your hands settle." };
    case "Processing":
      return { title, message: "The completed gesture is being recognized." };
    case "Sign recognized":
      return { title, message: "The latest completed gesture produced a final caption." };
    case "Sign not recognized":
      return { title, message: "Try the gesture again with your signing hand or hands clearly visible." };
    default:
      return { title, message: "Both shoulders and at least one signing hand are visible and calibrated." };
  }
}

function connectionLabel(status: string, recovered: boolean, hasMeeting: boolean, retryDelayMs?: number): string {
  if (status === "connected") return recovered ? "Connection recovered" : "Connected";
  if (status === "joining") return "Joining room";
  if (status === "connecting") return "Connecting";
  if (status === "reconnecting") {
    return retryDelayMs === undefined ? "Reconnecting" : `Reconnecting in ${retryDelayMs} ms`;
  }
  return hasMeeting ? "Room disconnected" : "Not connected";
}

function captionOccurredAt(occurredAt: string): string {
  return new Date(occurredAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function captionSourceLabel(sourceName: string, isCurrentParticipant: boolean): string {
  if (!isCurrentParticipant || sourceName.trim().toLocaleLowerCase() === "you") return sourceName;
  return `${sourceName} (you)`;
}

const PARTICIPANT_TONES = ["forest", "coral", "olive", "ochre", "slate"] as const;
type ParticipantTone = "self" | typeof PARTICIPANT_TONES[number];

function participantTone(identity: string, isCurrentParticipant: boolean): ParticipantTone {
  if (isCurrentParticipant) return "self";
  const hash = Array.from(identity).reduce(
    (current, character) => (current + (character.codePointAt(0) ?? 0)) >>> 0,
    0
  );
  const leadingCharacter = identity.codePointAt(0) ?? 0;
  return PARTICIPANT_TONES[(hash + leadingCharacter) % PARTICIPANT_TONES.length];
}

function participantInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "?";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase();
}

type SignerOwnershipState = {
  status: "idle" | "requesting" | "granted" | "denied";
  requestId: string | null;
  streamId: string | null;
};

const INITIAL_SIGNER_STATE: SignerOwnershipState = {
  status: "idle",
  requestId: null,
  streamId: null
};

function isOrderedRoomEvent(event: ServerRealtimeEvent): boolean {
  return event.type === "room.snapshot"
    || event.type === "participant.joined"
    || event.type === "participant.updated"
    || event.type === "participant.left"
    || event.type === "signer.granted"
    || event.type === "signer.released"
    || event.type === "chat.message"
    || (event.type === "caption.final" && event.participantId !== undefined);
}

function captureHealthLabel(status: LandmarkCaptureStatus): string {
  switch (status) {
    case "model-loading":
      return "Model loading";
    case "camera-waiting":
      return "Camera waiting";
    case "ready":
      return "Ready";
    case "tracking":
      return "Tracking";
    case "low-quality":
      return "Low quality";
    case "unavailable":
      return "Unavailable";
    case "error":
      return "Error";
    default:
      return "Stopped";
  }
}

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

const UPPER_BODY_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24]
];

function clearOverlay(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBrowserLocalOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  frame: BrowserLocalVisionFrame
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  synchronizeCanvasBackingStore(canvas);
  if (width <= 0 || height <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    clearOverlay(canvas);
    return;
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const containScale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const renderedWidth = video.videoWidth * containScale;
  const renderedHeight = video.videoHeight * containScale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;
  const project = (point: { x: number; y: number }) => ({
    x: offsetX + (1 - point.x) * renderedWidth,
    y: offsetY + point.y * renderedHeight
  });

  const drawConnections = (
    points: BrowserLocalVisionFrame["upperBody"],
    connections: ReadonlyArray<readonly [number, number]>,
    color: string,
    lineWidth: number
  ) => {
    const byIndex = new Map(points.map((point) => [point.index, point]));
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const [startIndex, endIndex] of connections) {
      const start = byIndex.get(startIndex);
      const end = byIndex.get(endIndex);
      if (!start || !end) continue;
      const a = project(start);
      const b = project(end);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
  };

  drawConnections(frame.upperBody, UPPER_BODY_CONNECTIONS, "rgba(192, 229, 215, 0.58)", 2);

  for (const hand of frame.hands) {
    drawConnections(hand.points, HAND_CONNECTIONS, "rgba(102, 239, 192, 0.9)", 2.4);
    for (const point of hand.points) {
      const position = project(point);
      context.beginPath();
      context.arc(position.x, position.y, point.index === 0 ? 4.2 : 2.8, 0, Math.PI * 2);
      context.fillStyle = point.index === 0 ? "#ffffff" : "#6aefc0";
      context.fill();
    }
  }
}

export function createMeetingApp(composition: MeetingAppComposition = {}): React.ComponentType {
  function MeetingAppConfigured() {
    const [meeting, setMeeting] = useState<Meeting | null>(null);
    const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(null);
    const [participants, setParticipants] = useState<RoomParticipant[]>([]);
    const [displayName, setDisplayName] = useState("You");
    const [joinCode, setJoinCode] = useState(() => {
      if (typeof window === "undefined") return "";
      return new URLSearchParams(window.location.search).get("room")?.toUpperCase() ?? "";
    });
    const [meetingRequestPending, setMeetingRequestPending] = useState(false);
    const [cameraState, setCameraState] = useState<CameraState>("off");
    const [trackingOverlayVisible, setTrackingOverlayVisible] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [signerOwnership, setSignerOwnership] = useState<SignerOwnershipState>(INITIAL_SIGNER_STATE);
    const [liveAnnouncement, setLiveAnnouncement] = useState("");
    const [product, dispatch] = useReducer(productReducer, INITIAL_PRODUCT_STATE);
    const [chatMessages, setChatMessages] = useState<ChatMessageEvent[]>([]);
    const [chatDraft, setChatDraft] = useState("");
    const [chatFeedback, setChatFeedback] = useState<string | null>(null);
    const [unreadTranscriptCount, setUnreadTranscriptCount] = useState(0);
    const [spokenEntries, setSpokenEntries] = useState<SpokenTranscriptEntry[]>([]);
    const [demoParticipants, setDemoParticipants] = useState<DemoParticipant[]>([]);
    const [demoSpokenEntries, setDemoSpokenEntries] = useState<SpokenTranscriptEntry[]>([]);
    const [speechStatus, setSpeechStatus] = useState<SpeechCaptureStatus>("idle");
    const [speechFeedback, setSpeechFeedback] = useState<string | null>(null);
    const [callState, setCallState] = useState<PeerCallState>("idle");
    const [callFeedback, setCallFeedback] = useState<string | null>(null);
    const [incomingCall, setIncomingCall] = useState<IncomingCallOffer | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [remoteMediaState, setRemoteMediaState] = useState({ audioEnabled: true, videoEnabled: true });
    const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
    const [callVideoEnabled, setCallVideoEnabled] = useState(true);
    const [selectedCallParticipantId, setSelectedCallParticipantId] = useState("");
    const [mediaDevices, setMediaDevices] = useState<MediaDeviceInfo[]>([]);
    const [selectedCameraId, setSelectedCameraId] = useState("");
    const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
    const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
    const roomPreviewToolsEnabled = composition.roomPreviewToolsEnabled
      ?? (ROOM_PREVIEW_TOOLS_ENABLED || LOCAL_ROOM_PREVIEW_ENABLED);
    useEffect(() => {
      if (product.latestRecognitionOutcome === null) return;
      const token = product.recognitionResultToken;
      const handle = window.setTimeout(() => {
        dispatch({ type: "recognition-result-expired", token });
      }, RECOGNITION_RESULT_DWELL_MS);
      return () => window.clearTimeout(handle);
    }, [product.latestRecognitionOutcome, product.recognitionResultToken]);
    const { toasts, pushToast, dismissToast } = useToastQueue();
    const announce = useCallback((message: string) => setLiveAnnouncement(message), []);
    const notify = useCallback((notice: Parameters<typeof pushToast>[0]) => {
      pushToast(notice);
      announce(`${notice.title}. ${notice.message}`);
    }, [announce, pushToast]);
    const videoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const browserLocalFrameRef = useRef<BrowserLocalVisionFrame | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const microphoneStreamRef = useRef<MediaStream | null>(null);
    const callControllerRef = useRef<PeerCallController | null>(null);
    const realtimeSendRef = useRef<(event: CallSignalCommand) => boolean>(() => false);
    const combinedCallStreamRef = useRef<() => MediaStream | null>(() => mediaStreamRef.current);
    const handleCallSignalRef = useRef<(event: CallSignalEvent) => void>(() => undefined);
    const stopCallRef = useRef<(reason?: string, notifyPeer?: boolean) => void>(() => undefined);
    const mediaTrackEndedListenersRef = useRef(new Map<MediaStreamTrack, EventListener>());
    const recognitionStreamRef = useRef<string | null>(null);
    const recentlyStoppedStreamRef = useRef<string | null>(null);
    const mountedRef = useRef(true);
    const cameraRequestGenerationRef = useRef(0);
    const meetingRequestGenerationRef = useRef(0);
    const roomGenerationRef = useRef(0);
    const lastRoomSequenceRef = useRef(-1);
    const signerCommandGenerationRef = useRef(-1);
    const signerCommandSequenceRef = useRef(0);
    const signerCommandTimestampRef = useRef(-1);
    const signerOwnershipRef = useRef(signerOwnership);
    const currentParticipantRef = useRef(currentParticipant);
    const revokeRecognitionRef = useRef<() => void>(() => undefined);
    const settleRecognitionGestureRef = useRef<(streamId: string) => void>(() => undefined);
    const stopMediaRef = useRef<() => void>(() => undefined);
    const speechControllerRef = useRef<SpeechRecognitionController | null>(null);
    const stopSpokenTranscriptRef = useRef<() => void>(() => undefined);
    const spokenEntrySequenceRef = useRef(0);
    const productRef = useRef(product);
    const transcriptListRef = useRef<HTMLDivElement>(null);
    const transcriptWasNearBottomRef = useRef(true);
    const previousTranscriptCountRef = useRef(0);

    signerOwnershipRef.current = signerOwnership;
    currentParticipantRef.current = currentParticipant;
    productRef.current = product;

    const stopSpokenTranscript = useCallback(() => {
      const controller = speechControllerRef.current;
      speechControllerRef.current = null;
      try {
        controller?.stop();
      } catch {
        // A browser recognizer can already be stopped when its end event races this action.
      }
      setSpeechStatus("idle");
      setSpeechFeedback(null);
    }, []);
    stopSpokenTranscriptRef.current = stopSpokenTranscript;

    const acceptServerEvent = useCallback((event: ServerRealtimeEvent, generation: number) => {
      if (roomGenerationRef.current !== generation) {
        roomGenerationRef.current = generation;
        lastRoomSequenceRef.current = -1;
      }
      if (isOrderedRoomEvent(event)) {
        if (event.sequence < lastRoomSequenceRef.current) {
          dispatch({ type: "room-order-issue" });
          return;
        }
        if (event.sequence === lastRoomSequenceRef.current) return;
        lastRoomSequenceRef.current = event.sequence;
      }
      if (event.type === "chat.message") {
        setChatMessages((current) => current.some((message) => message.messageId === event.messageId)
          ? current
          : [...current, event]);
        setChatFeedback(null);
        return;
      }
      if (event.type === "call.offer"
        || event.type === "call.answer"
        || event.type === "call.ice-candidate"
        || event.type === "call.decline"
        || event.type === "call.leave"
        || event.type === "media.state") {
        handleCallSignalRef.current(event);
        return;
      }
      if (event.type === "room.snapshot") {
        setParticipants(event.payload.participants);
        return;
      }
      if (event.type === "participant.joined"
        || event.type === "participant.updated"
        || event.type === "participant.left") {
        if (event.type !== "participant.left") {
          setParticipants((current) => [
            ...current.filter((participant) => participant.participantId !== event.participantId),
            {
              participantId: event.participantId,
              displayName: event.payload.displayName,
              role: event.payload.role,
              activeSigner: event.payload.activeSigner
            }
          ]);
        } else {
          setParticipants((current) => current.filter(
            (participant) => participant.participantId !== event.participantId
          ));
        }
        return;
      }
      if (event.type === "room.error") {
        if (event.payload.code === "INVALID_CHAT_MESSAGE") {
          setChatFeedback("That message could not be sent. Review it and try again.");
          return;
        }
        if (event.payload.code === "INVALID_CALL_SIGNAL"
          || event.payload.code === "CALL_TARGET_UNAVAILABLE") {
          setCallFeedback(event.payload.code === "CALL_TARGET_UNAVAILABLE"
            ? "That participant is no longer available for a call."
            : "The call signal was rejected. End the call and try again.");
          stopCallRef.current("signaling_error", false);
          return;
        }
        if (event.payload.code === "INVALID_SIGNER_EVENT") {
          signerOwnershipRef.current = INITIAL_SIGNER_STATE;
          setSignerOwnership(INITIAL_SIGNER_STATE);
          revokeRecognitionRef.current();
          dispatch({
            type: "signer-feedback",
            message: "The signer request was rejected. Start recognition again to retry."
          });
          return;
        }
        const message = event.payload.code === "ROOM_NOT_FOUND"
          ? "This room no longer exists. Start or join another room."
          : event.payload.code === "REALTIME_TICKET_EXPIRED" || event.payload.code === "TICKET_EXPIRED"
            ? "The realtime ticket expired. Rejoin the room to continue."
            : event.payload.code === "PARTICIPANT_CONNECTED"
              ? "This participant is already connected in another window."
            : event.payload.message;
        setError(message);
        setMeeting(null);
        setCurrentParticipant(null);
        setParticipants([]);
        setDemoParticipants([]);
        setDemoSpokenEntries([]);
        setSpokenEntries([]);
        setChatMessages([]);
        setChatDraft("");
        setChatFeedback(null);
        setIncomingCall(null);
        stopCallRef.current("room_closed", false);
        stopSpokenTranscriptRef.current();
        signerOwnershipRef.current = INITIAL_SIGNER_STATE;
        setSignerOwnership(INITIAL_SIGNER_STATE);
        revokeRecognitionRef.current();
        stopMediaRef.current();
        setCameraState("off");
        dispatch({ type: "reset-session" });
        return;
      }
      if (event.type === "room.joined") return;
      if (event.type === "signer.granted") {
        const pending = signerOwnershipRef.current;
        if (event.participantId === currentParticipantRef.current?.id
          && pending.status === "requesting"
          && event.payload.requestId === pending.requestId
          && event.payload.streamId === pending.streamId) {
          setSignerOwnership({ ...pending, status: "granted" });
          dispatch({ type: "signer-feedback", message: null });
        }
        return;
      }
      if (event.type === "signer.denied") {
        const pending = signerOwnershipRef.current;
        if (pending.status === "requesting"
          && event.payload.requestId === pending.requestId
          && event.streamId === pending.streamId) {
          const message = event.payload.reason === "ALREADY_ACTIVE"
            ? "You already control the active signer stream."
            : event.payload.reason === "NOT_JOINED"
              ? "Join the room again before starting recognition."
              : "Another participant is the active signer. Try again when they stop.";
          setSignerOwnership({ ...pending, status: "denied" });
          dispatch({ type: "signer-feedback", message });
          revokeRecognitionRef.current();
        }
        return;
      }
      if (event.type === "signer.released") {
        const ownership = signerOwnershipRef.current;
        if (event.participantId === currentParticipantRef.current?.id
          && event.payload.streamId === ownership.streamId) {
          setSignerOwnership(INITIAL_SIGNER_STATE);
          revokeRecognitionRef.current();
          dispatch({ type: "signer-feedback", message: "Signer access was released." });
        }
        return;
      }
      if (event.type === "caption.final" && event.participantId !== undefined) {
        dispatch({ type: "server-event", event });
        return;
      }
      const activeStream = recognitionStreamRef.current;
      if (event.streamId !== null && event.streamId !== activeStream) {
        const isTerminalStop = event.type === "recognition.status"
          && event.payload.state === "STOPPED"
          && event.streamId === recentlyStoppedStreamRef.current;
        if (!isTerminalStop) return;
        recentlyStoppedStreamRef.current = null;
      }
      if (event.type === "recognition.status"
        && (event.payload.state === "UNAVAILABLE"
          || event.payload.state === "INVALID_INPUT"
          || event.payload.state === "STOPPED")
        && event.streamId !== null
        && event.streamId === productRef.current.pendingRecognitionStreamId) {
        settleRecognitionGestureRef.current(event.streamId);
      }
      dispatch({ type: "server-event", event });
    }, []);

    const realtime = useRealtimeSession({
      socketFactory: composition.socketFactory,
      retryScheduler: composition.retryScheduler,
      maximumBufferedAmount: composition.maximumBufferedAmount,
      onEvent: acceptServerEvent,
      onParseIssue: (issue) => dispatch({ type: "parse-issue", reason: issue.reason })
    });
    realtimeSendRef.current = realtime.send;

    const refreshMediaDevices = useCallback(async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!mountedRef.current) return;
        setMediaDevices(devices);
        setSelectedCameraId((current) => current || devices.find((device) => device.kind === "videoinput")?.deviceId || "");
        setSelectedMicrophoneId((current) => current || devices.find((device) => device.kind === "audioinput")?.deviceId || "");
        setSelectedSpeakerId((current) => current || devices.find((device) => device.kind === "audiooutput")?.deviceId || "");
      } catch {
        setCallFeedback("Media device names are unavailable until browser permission is granted.");
      }
    }, []);

    useEffect(() => {
      void refreshMediaDevices();
      const devices = navigator.mediaDevices;
      if (!devices?.addEventListener) return;
      const refresh = () => void refreshMediaDevices();
      devices.addEventListener("devicechange", refresh);
      return () => devices.removeEventListener("devicechange", refresh);
    }, [refreshMediaDevices]);

    const stopCall = useCallback((reason = "user_left", notifyPeer = true) => {
      callControllerRef.current?.end(reason, notifyPeer);
      const microphoneStream = microphoneStreamRef.current;
      microphoneStreamRef.current = null;
      microphoneStream?.getTracks().forEach((track) => {
        const endedListener = mediaTrackEndedListenersRef.current.get(track);
        if (endedListener) track.removeEventListener("ended", endedListener);
        mediaTrackEndedListenersRef.current.delete(track);
        track.stop();
      });
      tracksOfKind(mediaStreamRef.current, "video").forEach((track) => {
        track.enabled = true;
      });
      setIncomingCall(null);
      setRemoteStream(null);
      setRemoteMediaState({ audioEnabled: true, videoEnabled: true });
      setMicrophoneEnabled(true);
      setCallVideoEnabled(true);
      setCallState("ended");
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    }, []);
    stopCallRef.current = stopCall;

    combinedCallStreamRef.current = () => {
      const cameraStream = mediaStreamRef.current;
      const microphoneStream = microphoneStreamRef.current;
      if (!cameraStream) return microphoneStream;
      if (!microphoneStream) return cameraStream;
      const tracks = [...tracksOfKind(cameraStream, "video"), ...tracksOfKind(microphoneStream, "audio")];
      const streamFactory = composition.mediaStreamFactory ?? ((streamTracks: MediaStreamTrack[]) => new MediaStream(streamTracks));
      return streamFactory(tracks);
    };

    useEffect(() => {
      if (!currentParticipant) {
        callControllerRef.current?.dispose();
        callControllerRef.current = null;
        return;
      }
      const controller = new PeerCallController({
        participantId: currentParticipant.id,
        send: (signal) => realtimeSendRef.current(signal),
        idFactory: composition.callIdFactory,
        peerConnectionFactory: composition.peerConnectionFactory,
        onStateChange: (state) => {
          if (!mountedRef.current) return;
          setCallState(state);
          if (state === "connected") {
            setCallFeedback("Private peer call connected.");
            announce("Private peer call connected.");
          }
          if (state === "failed") {
            setCallFeedback("The peer connection failed. End the call and try again.");
            announce("The peer connection failed. End the call and try again.");
          }
        },
        onRemoteStream: (stream) => {
          if (!mountedRef.current) return;
          setRemoteStream(stream);
        },
        onRemoteMediaState: (state) => {
          if (mountedRef.current) setRemoteMediaState(state);
        }
      });
      callControllerRef.current = controller;
      setCallState("idle");
      return () => {
        controller.dispose();
        if (callControllerRef.current === controller) callControllerRef.current = null;
      };
    }, [currentParticipant?.id]);

    handleCallSignalRef.current = (event) => {
      if (event.type === "call.offer") {
        if (incomingCall !== null
          || callState === "calling"
          || callState === "connecting"
          || callState === "connected") {
          realtimeSendRef.current({
            schemaVersion: 1,
            type: "call.decline",
            signalId: composition.callIdFactory?.() ?? crypto.randomUUID(),
            callId: event.callId,
            targetParticipantId: event.participantId,
            payload: { reason: "busy" }
          });
          return;
        }
        setIncomingCall(event);
        setCallFeedback("Incoming peer call. Accept to share your selected camera and microphone.");
        announce("Incoming peer call. Accept to share your selected camera and microphone.");
        return;
      }
      void callControllerRef.current?.handleSignal(event, combinedCallStreamRef.current()).then(() => {
        if (event.type === "call.decline" || event.type === "call.leave") {
          stopCall("remote_ended", false);
          setCallFeedback(event.type === "call.decline" ? "The participant declined the call." : "The participant ended the call.");
          announce(event.type === "call.decline" ? "The participant declined the call." : "The participant ended the call.");
        }
      }).catch(() => {
        setCallState("failed");
        setCallFeedback("Call signaling could not be completed. End the call and try again.");
      });
    };

    useEffect(() => {
      const video = remoteVideoRef.current;
      if (!video) return;
      video.srcObject = remoteStream;
      if (remoteStream) void video.play().catch(() => undefined);
    }, [remoteStream]);

    useEffect(() => {
      if (!selectedSpeakerId || !remoteVideoRef.current) return;
      const outputVideo = remoteVideoRef.current as HTMLVideoElement & {
        setSinkId?: (deviceId: string) => Promise<void>;
      };
      void outputVideo.setSinkId?.(selectedSpeakerId).catch(() => {
        setCallFeedback("This browser could not switch the selected speaker.");
      });
    }, [remoteStream, selectedSpeakerId]);

    function nextSignerCommandOrder(): { sequence: number; timestampMs: number } {
      if (signerCommandGenerationRef.current !== realtime.state.generation) {
        signerCommandGenerationRef.current = realtime.state.generation;
        signerCommandSequenceRef.current = 0;
        signerCommandTimestampRef.current = -1;
      }
      const sampledTimestamp = composition.clock?.now() ?? performance.now();
      const normalizedTimestamp = Number.isFinite(sampledTimestamp) && sampledTimestamp >= 0
        ? sampledTimestamp
        : 0;
      const timestampMs = Math.max(normalizedTimestamp, signerCommandTimestampRef.current + 0.001);
      return { sequence: signerCommandSequenceRef.current, timestampMs };
    }

    function commitSignerCommandOrder(timestampMs: number): void {
      signerCommandSequenceRef.current += 1;
      signerCommandTimestampRef.current = timestampMs;
    }

    const recognition = useSignRecognition({
      cameraEnabled: cameraState === "on",
      getVideo: () => videoRef.current,
      realtimeState: realtime.state,
      send: realtime.send,
      isUnderPressure: realtime.isUnderPressure,
      captureOptions: composition.captureOptions,
      clock: composition.clock,
      signerGranted: signerOwnership.status === "granted"
        && signerOwnership.streamId === recognitionStreamRef.current,
      trackingAnnouncementDelayMs: composition.trackingAnnouncementDelayMs,
      onGestureDispatched: (streamId) => dispatch({ type: "gesture-dispatched", streamId }),
      onStreamChange: (streamId) => {
        const previousStreamId = recognitionStreamRef.current;
        if (streamId === null && previousStreamId !== null) {
          recentlyStoppedStreamRef.current = previousStreamId;
          dispatch({ type: "recognition-ended", streamId: previousStreamId });
        } else if (streamId !== null) {
          recentlyStoppedStreamRef.current = null;
        }
        recognitionStreamRef.current = streamId;
      },
      onOwnershipReleaseNeeded: releaseSigner
    });
    browserLocalFrameRef.current = recognition.browserLocalFrame;
    revokeRecognitionRef.current = recognition.revoke;
    settleRecognitionGestureRef.current = recognition.settleGesture;

    useEffect(() => {
      const streamId = product.pendingRecognitionStreamId;
      if (streamId === null) return;
      const configuredTimeout = composition.recognitionResponseTimeoutMs
        ?? RECOGNITION_RESPONSE_TIMEOUT_MS;
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : RECOGNITION_RESPONSE_TIMEOUT_MS;
      const handle = window.setTimeout(() => {
        if (productRef.current.pendingRecognitionStreamId !== streamId) return;
        recognition.settleGesture(streamId);
        dispatch({ type: "recognition-timeout", streamId });
        recognition.stop();
      }, timeoutMs);
      return () => window.clearTimeout(handle);
    }, [product.pendingRecognitionStreamId, recognition.settleGesture, recognition.stop]);

    useEffect(() => {
      if (product.latestRecognitionStreamId !== null) {
        recognition.settleGesture(product.latestRecognitionStreamId);
      }
    }, [product.latestRecognitionStreamId, product.recognitionResultToken, recognition.settleGesture]);

    useEffect(() => {
      const streamId = recognition.streamId;
      if (!recognition.enabledByUser
        || !streamId
        || realtime.state.status !== "connected") return;

      const current = signerOwnershipRef.current;
      if (current.streamId === streamId
        && (current.status === "requesting" || current.status === "granted")) return;

      let requestId: string;
      try {
        requestId = composition.requestIdFactory?.() ?? crypto.randomUUID();
      } catch {
        recognition.revoke();
        dispatch({ type: "signer-feedback", message: "Signer access could not be requested. Try again." });
        return;
      }
      const commandOrder = nextSignerCommandOrder();
      const next: SignerOwnershipState = {
        status: "requesting",
        requestId,
        streamId
      };
      signerOwnershipRef.current = next;
      setSignerOwnership(next);
      dispatch({ type: "signer-feedback", message: null });
      const sent = realtime.send({
        schemaVersion: 1,
        type: "signer.request",
        requestId,
        streamId,
        sequence: commandOrder.sequence,
        timestampMs: commandOrder.timestampMs
      });
      if (sent) commitSignerCommandOrder(commandOrder.timestampMs);
      if (!sent) {
        signerOwnershipRef.current = { ...next, status: "denied" };
        setSignerOwnership({ ...next, status: "denied" });
        recognition.revoke();
        dispatch({ type: "signer-feedback", message: "Signer access could not be requested. Check the room connection and try again." });
      }
    }, [recognition.enabledByUser, recognition.streamId, realtime.state.generation, realtime.state.status]);

    const previousRealtimeStatusRef = useRef(realtime.state.status);
    useEffect(() => {
      const previousStatus = previousRealtimeStatusRef.current;
      const currentStatus = realtime.state.status;

      if (currentStatus === "connected" && previousStatus !== "connected") {
        notify({
          key: "realtime-connection",
          tone: "success",
          title: realtime.state.recovered || previousStatus === "reconnecting"
            ? "Connection restored"
            : "Session connected",
          message: meeting ? `Room ${meeting.id.slice(0, 8)} is ready.` : "The realtime session is ready."
        });
      } else if (currentStatus === "reconnecting" && previousStatus === "connected") {
        signerOwnershipRef.current = INITIAL_SIGNER_STATE;
        setSignerOwnership(INITIAL_SIGNER_STATE);
        notify({
          key: "realtime-connection",
          tone: "info",
          title: "Connection interrupted",
          message: "SignConnect is attempting to reconnect."
        });
      }

      previousRealtimeStatusRef.current = currentStatus;
    }, [meeting, notify, realtime.state.recovered, realtime.state.status]);

    useEffect(() => {
      if (recognition.trackingAnnouncement) {
        announce(recognition.trackingAnnouncement);
      } else if (recognition.captureStatus === "unavailable") {
        announce("Recognition model unavailable.");
      } else if (recognition.captureStatus === "error") {
        announce("Recognition tracking stopped unexpectedly.");
      }
    }, [announce, recognition.captureStatus, recognition.trackingAnnouncement]);

    const previousProductAnnouncementRef = useRef({
      recognitionFeedback: INITIAL_PRODUCT_STATE.recognitionFeedback,
      serviceStatus: INITIAL_PRODUCT_STATE.serviceStatus,
      protocolFeedback: INITIAL_PRODUCT_STATE.protocolFeedback,
      signerFeedback: INITIAL_PRODUCT_STATE.signerFeedback
    });
    useEffect(() => {
      const previous = previousProductAnnouncementRef.current;
      const feedback = product.signerFeedback !== previous.signerFeedback
        ? product.signerFeedback
        : product.protocolFeedback !== previous.protocolFeedback
          ? product.protocolFeedback
          : product.recognitionFeedback !== previous.recognitionFeedback
            ? product.recognitionFeedback
            : product.serviceStatus !== previous.serviceStatus
              ? product.serviceStatus
              : null;
      if (feedback) announce(feedback);
      previousProductAnnouncementRef.current = {
        recognitionFeedback: product.recognitionFeedback,
        serviceStatus: product.serviceStatus,
        protocolFeedback: product.protocolFeedback,
        signerFeedback: product.signerFeedback
      };
    }, [announce, product.protocolFeedback, product.recognitionFeedback, product.serviceStatus, product.signerFeedback]);

    useEffect(() => {
      if (error && meeting) announce(error);
    }, [announce, error, meeting]);

    const lastAnnouncedCaptionRef = useRef<string | null>(null);
    useEffect(() => {
      const caption = product.captions.at(-1);
      if (!caption) {
        lastAnnouncedCaptionRef.current = null;
        return;
      }
      const identity = caption.captionId ?? `${caption.streamId}-${caption.sequence}`;
      if (lastAnnouncedCaptionRef.current === identity) return;
      lastAnnouncedCaptionRef.current = identity;
      announce(`Caption from ${caption.payload.sourceDisplayName ?? "participant"}: ${caption.payload.text}`);
    }, [announce, product.captions]);

    useEffect(() => {
      const frame = recognition.browserLocalFrame;
      const canvas = overlayCanvasRef.current;
      const video = videoRef.current;
      if (!trackingOverlayVisible || !frame || !canvas || !video) {
        clearOverlay(canvas);
        return;
      }

      drawBrowserLocalOverlay(canvas, video, frame);
    }, [recognition.browserLocalFrame, trackingOverlayVisible]);

    useEffect(() => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;
      return observeCanvasBackingStore(canvas, () => {
        const frame = browserLocalFrameRef.current;
        const video = videoRef.current;
        if (trackingOverlayVisible && frame && video) drawBrowserLocalOverlay(canvas, video, frame);
        else clearOverlay(canvas);
      });
    }, [trackingOverlayVisible]);

    const stopMedia = useCallback(() => {
      cameraRequestGenerationRef.current += 1;
      stopCallRef.current("camera_stopped", true);
      const stream = mediaStreamRef.current;
      mediaStreamRef.current = null;
      mediaTrackEndedListenersRef.current.forEach((listener, track) => {
        track.removeEventListener("ended", listener);
      });
      mediaTrackEndedListenersRef.current.clear();
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      clearOverlay(overlayCanvasRef.current);
    }, []);
    stopMediaRef.current = stopMedia;

    function releaseSigner(streamId: string, reason: SignerReleaseEvent["reason"]): void {
      const ownership = signerOwnershipRef.current;
      if (ownership.streamId !== streamId) return;
      if (realtime.state.status === "connected") {
        const commandOrder = nextSignerCommandOrder();
        const sent = realtime.send({
          schemaVersion: 1,
          type: "signer.release",
          streamId,
          sequence: commandOrder.sequence,
          timestampMs: commandOrder.timestampMs,
          reason
        });
        if (sent) commitSignerCommandOrder(commandOrder.timestampMs);
      }
      signerOwnershipRef.current = INITIAL_SIGNER_STATE;
      setSignerOwnership(INITIAL_SIGNER_STATE);
    }

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        meetingRequestGenerationRef.current += 1;
        stopSpokenTranscript();
        stopMedia();
      };
    }, [stopMedia, stopSpokenTranscript]);

    async function toggleCamera() {
      if (cameraState === "on") {
        const recognitionWasActive = recognition.enabledByUser;
        recognition.cameraOff();
        stopMedia();
        setCameraState("off");
        notify({
          key: "camera",
          tone: "info",
          title: "Camera turned off",
          message: recognitionWasActive ? "Camera and recognition capture stopped." : "Browser preview stopped."
        });
        return;
      }
      if (cameraState === "requesting") return;

      const requestGeneration = ++cameraRequestGenerationRef.current;
      setCameraState("requesting");
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 960 },
            aspectRatio: { ideal: 4 / 3 },
            facingMode: "user",
            ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {})
          },
          audio: false
        });
        if (!mountedRef.current || requestGeneration !== cameraRequestGenerationRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStreamRef.current = stream;
        stream.getTracks().forEach((track) => {
          const handleEnded = () => {
            if (!mountedRef.current
              || requestGeneration !== cameraRequestGenerationRef.current
              || mediaStreamRef.current !== stream) {
              return;
            }
            recognition.cameraOff();
            stopMedia();
            setCameraState("error");
            setError("The camera disconnected or its permission was revoked.");
            notify({
              key: "camera",
              tone: "error",
              title: "Camera disconnected",
              message: "Restore browser permission or reconnect the camera."
            });
          };
          track.addEventListener("ended", handleEnded);
          mediaTrackEndedListenersRef.current.set(track, handleEnded);
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
        setCameraState("on");
        setCallVideoEnabled(true);
        void refreshMediaDevices();
        notify({
          key: "camera",
          tone: "success",
          title: "Camera ready",
          message: "Browser preview is active."
        });
      } catch (cameraError) {
        if (!mountedRef.current || requestGeneration !== cameraRequestGenerationRef.current) return;
        const failure = cameraFailure(cameraError);
        setCameraState(failure.state);
        setError(failure.message);
        notify({
          key: "camera",
          tone: "error",
          title: "Camera unavailable",
          message: "Check browser camera access and try again."
        });
      }
    }

    function activateMeetingSession(session: Awaited<ReturnType<typeof createMeeting>>) {
      dispatch({ type: "reset-session" });
      stopCall("room_changed", false);
      stopSpokenTranscript();
      setSpokenEntries([]);
      setChatMessages([]);
      setChatDraft("");
      setChatFeedback(null);
      setDemoParticipants([]);
      setDemoSpokenEntries([]);
      setMeeting(session.meeting);
      setCurrentParticipant(session.participant);
      setParticipants([]);
      signerOwnershipRef.current = INITIAL_SIGNER_STATE;
      setSignerOwnership(INITIAL_SIGNER_STATE);
      realtime.connect(session.meeting.id, session.realtimeTicket);
    }

    function meetingFailureMessage(failure: unknown): string {
      if (failure instanceof MeetingRequestError) return failure.message;
      return "The meeting service is unavailable.";
    }

    async function startMeeting() {
      const normalizedName = displayName.trim();
      if (!normalizedName) {
        setError("Enter your display name before creating a room.");
        return;
      }
      const requestGeneration = ++meetingRequestGenerationRef.current;
      setMeetingRequestPending(true);
      setError(null);
      dispatch({ type: "reset-session" });
      try {
        const createdSession = await createMeeting("Accessible team sync", normalizedName);
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        activateMeetingSession(createdSession);
      } catch (failure) {
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        setError(meetingFailureMessage(failure));
        notify({
          key: "realtime-connection",
          tone: "error",
          title: "Session could not start",
          message: "Check that the meeting service is running and try again."
        });
      } finally {
        if (mountedRef.current && requestGeneration === meetingRequestGenerationRef.current) {
          setMeetingRequestPending(false);
        }
      }
    }

    async function joinExistingMeeting() {
      const normalizedName = displayName.trim();
      const normalizedCode = joinCode.replace(/\s+/g, "").toUpperCase();
      if (!normalizedName) {
        setError("Enter your display name before joining a room.");
        return;
      }
      if (normalizedCode.length !== 6) {
        setError("Enter the six-character room code.");
        return;
      }
      const requestGeneration = ++meetingRequestGenerationRef.current;
      setMeetingRequestPending(true);
      setError(null);
      dispatch({ type: "reset-session" });
      try {
        const joinedSession = await joinMeeting(normalizedCode, normalizedName);
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        activateMeetingSession(joinedSession);
      } catch (failure) {
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        setError(meetingFailureMessage(failure));
        notify({
          key: "realtime-connection",
          tone: "error",
          title: "Room could not be joined",
          message: failure instanceof MeetingRequestError && failure.status === 404
            ? "Check the room code and ask the host to share it again."
            : "Check that the meeting service is running and try again."
        });
      } finally {
        if (mountedRef.current && requestGeneration === meetingRequestGenerationRef.current) {
          setMeetingRequestPending(false);
        }
      }
    }

    async function copyInviteLink() {
      if (!meeting) return;
      const invite = `${window.location.origin}${window.location.pathname}?room=${meeting.joinCode}`;
      try {
        await navigator.clipboard.writeText(invite);
        notify({
          key: "room-invite",
          tone: "success",
          title: "Invitation copied",
          message: `Room ${meeting.joinCode} is ready to share.`
        });
      } catch {
        setError(`Copy this room code: ${meeting.joinCode}`);
      }
    }

    function startSpokenTranscript() {
      if (!meeting || speechControllerRef.current) return;
      const speechFactory = composition.speechRecognitionFactory ?? createBrowserSpeechRecognition;
      const controller = speechFactory({
        onStart: () => {
          if (!mountedRef.current) return;
          setSpeechStatus("listening");
          setSpeechFeedback(null);
          announce("Spoken transcript started. Listening to your microphone.");
        },
        onFinalTranscript: (text) => {
          if (!mountedRef.current) return;
          const normalizedText = text.trim().replace(/\s+/g, " ").slice(0, 500);
          if (!normalizedText) return;
          spokenEntrySequenceRef.current += 1;
          setSpokenEntries((current) => [...current, {
            id: `speech-${spokenEntrySequenceRef.current}`,
            sourceDisplayName: currentParticipant?.displayName ?? (displayName.trim() || "You"),
            text: normalizedText,
            occurredAt: new Date().toISOString()
          }]);
          announce(`Spoken transcript: ${normalizedText}`);
        },
        onError: (reason) => {
          if (!mountedRef.current) return;
          speechControllerRef.current = null;
          const permissionDenied = reason === "not-allowed" || reason === "service-not-allowed";
          setSpeechStatus(permissionDenied ? "permission-denied" : "error");
          setSpeechFeedback(permissionDenied
            ? "Microphone permission was not granted. Update browser permissions to capture spoken notes."
            : "Spoken transcript stopped because the browser speech service was unavailable.");
        },
        onEnd: () => {
          if (!mountedRef.current) return;
          speechControllerRef.current = null;
          setSpeechStatus((current) => current === "permission-denied" || current === "error" ? current : "idle");
        }
      });

      if (!controller) {
        setSpeechStatus("unsupported");
        setSpeechFeedback("This browser does not offer spoken transcript capture.");
        return;
      }

      speechControllerRef.current = controller;
      setSpeechStatus("starting");
      setSpeechFeedback(null);
      try {
        controller.start();
      } catch {
        speechControllerRef.current = null;
        setSpeechStatus("error");
        setSpeechFeedback("Spoken transcript could not start. Try again after checking microphone access.");
      }
    }

    function clearTranscript() {
      dispatch({ type: "clear-transcript" });
      setSpokenEntries([]);
      setDemoSpokenEntries([]);
      setChatMessages([]);
      announce("Live transcript cleared from this browser session.");
    }

    function sendChatMessage(event: React.FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const text = chatDraft.trim();
      if (!text || text.length > 500) return;
      const messageId = composition.messageIdFactory?.() ?? crypto.randomUUID();
      if (!realtime.send({
        schemaVersion: 1,
        type: "chat.message",
        messageId,
        text
      })) {
        setChatFeedback("Message could not be sent while the room is reconnecting. Try again when connected.");
        return;
      }
      setChatDraft("");
      setChatFeedback("Sending message…");
    }

    async function requestCallMicrophone(): Promise<MediaStream> {
      if (microphoneStreamRef.current) return microphoneStreamRef.current;
      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: selectedMicrophoneId ? { deviceId: { exact: selectedMicrophoneId } } : true
      });
      tracksOfKind(microphoneStream, "audio").forEach((track) => {
        track.enabled = true;
        const handleEnded = () => {
          if (!mountedRef.current || microphoneStreamRef.current !== microphoneStream) return;
          stopCallRef.current("microphone_disconnected", true);
          setCallFeedback("The microphone disconnected. Reconnect it before starting another call.");
          announce("The call ended because the microphone disconnected.");
        };
        track.addEventListener("ended", handleEnded);
        mediaTrackEndedListenersRef.current.set(track, handleEnded);
      });
      microphoneStreamRef.current = microphoneStream;
      setMicrophoneEnabled(true);
      void refreshMediaDevices();
      return microphoneStream;
    }

    async function startPeerCall() {
      if (!selectedCallParticipantId || cameraState !== "on" || !callControllerRef.current) return;
      setCallFeedback("Requesting microphone access…");
      try {
        await requestCallMicrophone();
        const callStream = combinedCallStreamRef.current();
        if (!callStream) throw new Error("Local media is unavailable.");
        await callControllerRef.current.startCall(selectedCallParticipantId, callStream);
        setCallFeedback("Calling the selected participant…");
      } catch {
        microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = null;
        setCallState("failed");
        setCallFeedback("The call could not start. Check microphone permission and try again.");
      }
    }

    async function acceptIncomingCall() {
      if (!incomingCall || cameraState !== "on" || !callControllerRef.current) return;
      const offer = incomingCall;
      setCallFeedback("Requesting microphone access…");
      try {
        await requestCallMicrophone();
        setSelectedCallParticipantId(offer.participantId);
        setIncomingCall(null);
        await callControllerRef.current.handleSignal(offer, combinedCallStreamRef.current());
        setCallFeedback("Connecting the private peer call…");
      } catch {
        setCallState("failed");
        setCallFeedback("The call could not be accepted. Check camera and microphone permissions.");
      }
    }

    function declineIncomingCall() {
      if (!incomingCall) return;
      realtimeSendRef.current({
        schemaVersion: 1,
        type: "call.decline",
        signalId: composition.callIdFactory?.() ?? crypto.randomUUID(),
        callId: incomingCall.callId,
        targetParticipantId: incomingCall.participantId,
        payload: { reason: "declined" }
      });
      setIncomingCall(null);
      setCallState("ended");
      setCallFeedback("Incoming call declined.");
      announce("Incoming call declined.");
    }

    function toggleCallMicrophone() {
      const enabled = !microphoneEnabled;
      tracksOfKind(microphoneStreamRef.current, "audio").forEach((track) => {
        track.enabled = enabled;
      });
      setMicrophoneEnabled(enabled);
      callControllerRef.current?.sendMediaState(enabled, callVideoEnabled);
      announce(enabled ? "Call microphone unmuted." : "Call microphone muted.");
    }

    function toggleCallVideo() {
      const enabled = !callVideoEnabled;
      tracksOfKind(mediaStreamRef.current, "video").forEach((track) => {
        track.enabled = enabled;
      });
      setCallVideoEnabled(enabled);
      callControllerRef.current?.sendMediaState(microphoneEnabled, enabled);
      announce(enabled ? "Call camera resumed." : "Call camera paused.");
    }

    function addDemoParticipant() {
      const nextDemo = DEMO_PARTICIPANTS[demoParticipants.length];
      if (!nextDemo) return;
      setDemoParticipants((current) => [...current, nextDemo.participant]);
      setDemoSpokenEntries((current) => [...current, {
        id: `demo-speech-${nextDemo.participant.participantId}`,
        sourceDisplayName: nextDemo.participant.displayName,
        text: nextDemo.sampleSpeech,
        occurredAt: new Date(Date.now() + demoParticipants.length).toISOString(),
        simulated: true
      }]);
      announce(`${nextDemo.participant.displayName} added to the local room preview.`);
    }

    function removeDemoParticipants() {
      setDemoParticipants([]);
      setDemoSpokenEntries([]);
      announce("Demo participants removed from the local room preview.");
    }

    function toggleRecognition() {
      if (recognition.enabledByUser) {
        recognition.stop();
        notify({
          key: "recognition",
          tone: "info",
          title: "Capture ended",
          message: "Recognition is no longer running."
        });
      } else if (recognition.start()) {
        notify({
          key: "recognition",
          tone: "info",
          title: "Signer access requested",
          message: "Recognition will start after the room grants signer access."
        });
      }
    }

    const connected = realtime.state.status === "connected";
    const canStartRecognition = cameraState === "on" && connected;
    const recognitionControlDisabled = recognition.enabledByUser ? false : !canStartRecognition;
    const disabledReason = recognitionDisabledReason(cameraState, connected);
    const currentConnectionLabel = connectionLabel(
      realtime.state.status,
      realtime.state.recovered,
      meeting !== null,
      realtime.state.retryDelayMs
    );
    const cameraEnabled = cameraState === "on";
    const signerRequestPending = recognition.enabledByUser && signerOwnership.status === "requesting";
    const signerGranted = recognition.enabledByUser && signerOwnership.status === "granted";
    const activeSigner = participants.find((participant) => participant.activeSigner);
    const mockNoticeVisible = product.mockModelActive;
    const aslResearchNoticeVisible = product.activeModelVersion?.startsWith("asl-wlasl-") === true;
    const browserLocalFrame = recognition.browserLocalFrame;
    const readinessGuidance = cameraReadinessGuidance(
      cameraState,
      recognition.enabledByUser,
      browserLocalFrame,
      product.pendingRecognitionStreamId !== null,
      product.latestRecognitionOutcome
    );
    const trackedHandCount = browserLocalFrame?.hands.length ?? 0;
    const trackingLost = recognition.enabledByUser && recognition.captureStatus === "low-quality";
    const landmarkExtractorLabel = !recognition.enabledByUser
      ? recognition.captureStatus === "model-loading"
        ? "Preloading hand and pose landmarks"
        : recognition.captureStatus === "ready"
          ? "Hand and pose landmarks ready"
          : "Loads after the camera and session connect"
      : browserLocalFrame
        ? "Hand and pose landmarks ready"
        : recognition.captureStatus === "unavailable"
          ? "Landmark models unavailable"
          : "Loading landmark models";
    const previousReadinessTitleRef = useRef("");
    useEffect(() => {
      if (!recognition.enabledByUser || previousReadinessTitleRef.current === readinessGuidance.title) return;
      previousReadinessTitleRef.current = readinessGuidance.title;
      announce(readinessGuidance.title + ". " + readinessGuidance.message);
    }, [announce, readinessGuidance.message, readinessGuidance.title, recognition.enabledByUser]);

    const visibleParticipants: Array<RoomParticipant | DemoParticipant> = [
      ...participants,
      ...demoParticipants
    ];
    const callParticipants = participants.filter(
      (participant) => participant.participantId !== currentParticipant?.id
    );
    useEffect(() => {
      setSelectedCallParticipantId((current) => callParticipants.some(
        (participant) => participant.participantId === current
      ) ? current : callParticipants[0]?.participantId ?? "");
    }, [currentParticipant?.id, participants]);
    const selectedCallParticipant = callParticipants.find(
      (participant) => participant.participantId === selectedCallParticipantId
    );
    const incomingCallParticipant = incomingCall
      ? participants.find((participant) => participant.participantId === incomingCall.participantId)
      : undefined;
    const callActive = callState === "calling" || callState === "connecting" || callState === "connected";
    const cameraDevices = mediaDevices.filter((device) => device.kind === "videoinput");
    const microphoneDevices = mediaDevices.filter((device) => device.kind === "audioinput");
    const speakerDevices = mediaDevices.filter((device) => device.kind === "audiooutput");
    const transcriptEntries = useMemo(() => [
      ...product.captions.map((caption) => ({ kind: "sign" as const, occurredAt: caption.occurredAt, caption })),
      ...chatMessages.map((message) => ({ kind: "chat" as const, occurredAt: message.occurredAt, message })),
      ...spokenEntries.map((entry) => ({ kind: "speech" as const, occurredAt: entry.occurredAt, entry })),
      ...demoSpokenEntries.map((entry) => ({ kind: "speech" as const, occurredAt: entry.occurredAt, entry }))
    ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)), [
      chatMessages,
      demoSpokenEntries,
      product.captions,
      spokenEntries
    ]);
    const scrollTranscriptToLatest = useCallback((focusHistory = false) => {
      const transcriptList = transcriptListRef.current;
      if (!transcriptList) return;
      if (focusHistory) transcriptList.focus({ preventScroll: true });
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      if (typeof transcriptList.scrollTo === "function") {
        transcriptList.scrollTo({
          top: transcriptList.scrollHeight,
          behavior: reduceMotion ? "auto" : "smooth"
        });
      } else {
        transcriptList.scrollTop = transcriptList.scrollHeight;
      }
      transcriptWasNearBottomRef.current = true;
      setUnreadTranscriptCount(0);
    }, []);
    const handleTranscriptScroll = useCallback(() => {
      const transcriptList = transcriptListRef.current;
      if (!transcriptList) return;
      const remainingDistance = transcriptList.scrollHeight
        - transcriptList.clientHeight
        - transcriptList.scrollTop;
      const isNearBottom = remainingDistance <= 48;
      transcriptWasNearBottomRef.current = isNearBottom;
      if (isNearBottom) setUnreadTranscriptCount(0);
    }, []);
    useLayoutEffect(() => {
      const currentCount = transcriptEntries.length;
      const previousCount = previousTranscriptCountRef.current;
      previousTranscriptCountRef.current = currentCount;
      if (currentCount === 0) {
        transcriptWasNearBottomRef.current = true;
        setUnreadTranscriptCount(0);
        return;
      }
      if (currentCount <= previousCount) return;

      const latestEntry = transcriptEntries[currentCount - 1];
      const isCurrentParticipantEntry = currentParticipant !== null && (
        (latestEntry.kind === "chat" && latestEntry.message.participantId === currentParticipant.id)
        || (latestEntry.kind === "sign" && latestEntry.caption.participantId === currentParticipant.id)
        || (latestEntry.kind === "speech"
          && !latestEntry.entry.simulated
          && latestEntry.entry.sourceDisplayName === currentParticipant.displayName)
      );
      if (transcriptWasNearBottomRef.current || isCurrentParticipantEntry) {
        scrollTranscriptToLatest();
        return;
      }
      setUnreadTranscriptCount((count) => count + (currentCount - previousCount));
    }, [currentParticipant, scrollTranscriptToLatest, transcriptEntries]);
    const speechCaptureActive = speechStatus === "starting" || speechStatus === "listening";
    const speechStatusLabel = speechStatus === "listening"
      ? "Listening to your microphone"
      : speechStatus === "starting"
        ? "Requesting microphone access"
        : speechStatus === "unsupported"
          ? "Spoken transcript is not supported by this browser"
          : speechStatus === "permission-denied"
            ? "Microphone permission is needed"
            : speechStatus === "error"
              ? "Spoken transcript is unavailable"
              : "Spoken transcript is off";

    return (
      <section className="studio-workspace" aria-labelledby="meeting-title">
        <ToastViewport toasts={toasts} onDismiss={dismissToast} />
        <header className="studio-header">
          <div className="studio-heading">
            <span>Live workspace</span>
            <h1 id="meeting-title">Recognition studio</h1>
          </div>

          <div className="session-cluster">
            <div className={`connection-state ${realtime.state.status}`}>
              {(realtime.state.status === "connecting"
                || realtime.state.status === "joining"
                || realtime.state.status === "reconnecting") && (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              )}
              {connected && <Radio size={14} aria-hidden="true" />}
              {realtime.state.status === "idle" && <span className="idle-dot" aria-hidden="true" />}
              {currentConnectionLabel}
            </div>
            <span className="room-reference">{meeting ? `Room ${meeting.joinCode}` : "No active room"}</span>
            {meeting && (
              <button
                type="button"
                className="sc-button sc-button--confirmed session-control"
                disabled
              >
                {connected ? <Check size={15} aria-hidden="true" /> : <LoaderCircle size={15} className="spin" aria-hidden="true" />}
                <span className="sc-button__label">{connected ? "Session active" : "Joining…"}</span>
              </button>
            )}
          </div>
        </header>

        <div className="workspace-notices">
          {error && (
            <div
              className="meeting-alert"
              role={meeting ? undefined : "alert"}
              aria-label="Meeting error"
              aria-live={meeting ? undefined : "assertive"}
              aria-atomic={meeting ? undefined : "true"}
            >
              <CircleAlert size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {!meeting ? (
            <section
              className="room-entry-panel"
              id="room-participants"
              tabIndex={-1}
              aria-labelledby="room-entry-title"
            >
              <div className="room-entry-intro">
                <span className="room-entry-icon"><Users size={17} aria-hidden="true" /></span>
                <div>
                  <strong id="room-entry-title">Open a shared room</strong>
                  <span>Create a new conversation or enter a code from another participant.</span>
                </div>
              </div>

              <label className="room-field room-name-field">
                <span>Display name</span>
                <input
                  value={displayName}
                  maxLength={50}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={meetingRequestPending}
                  autoComplete="name"
                />
              </label>

              <button
                type="button"
                className="sc-button sc-button--ink session-control"
                onClick={startMeeting}
                disabled={meetingRequestPending || realtime.state.status !== "idle"}
              >
                {meetingRequestPending
                  ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  : <Plus size={15} aria-hidden="true" />}
                <span className="sc-button__label">
                  {meetingRequestPending ? "Opening…" : "Start session"}
                </span>
              </button>

              <span className="room-entry-divider" aria-hidden="true">or</span>

              <label className="room-field room-code-field">
                <span>Room code</span>
                <input
                  value={joinCode}
                  maxLength={6}
                  placeholder="ABC234"
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  disabled={meetingRequestPending}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>

              <button
                type="button"
                className="sc-button sc-button--secondary session-control"
                onClick={joinExistingMeeting}
                disabled={meetingRequestPending || realtime.state.status !== "idle"}
              >
                <LogIn size={15} aria-hidden="true" />
                <span className="sc-button__label">Join room</span>
              </button>
            </section>
          ) : (
            <section
              className="room-presence-bar"
              id="room-participants"
              tabIndex={-1}
              aria-label="Room participants"
            >
              <div className="room-identity">
                <span>Share code</span>
                <strong>{meeting.joinCode}</strong>
                <button
                  type="button"
                  className="sc-icon-button room-copy-action"
                  aria-label="Copy room invitation"
                  onClick={copyInviteLink}
                >
                  <Copy size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="participant-summary">
                <Users size={14} aria-hidden="true" />
                <span>{visibleParticipants.length} participant{visibleParticipants.length === 1 ? "" : "s"}</span>
              </div>
              <ul className="participant-list" aria-label="People in this room">
                {visibleParticipants.map((roomParticipant) => (
                  <li key={roomParticipant.participantId}>
                    <span className="participant-avatar" aria-hidden="true">
                      {roomParticipant.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{roomParticipant.displayName}</span>
                    {roomParticipant.participantId === currentParticipant?.id && <em>You</em>}
                    {roomParticipant.role === "HOST" && <small>Host</small>}
                    {roomParticipant.activeSigner && <small>Signer</small>}
                    {"simulated" in roomParticipant && roomParticipant.simulated && <small>Demo</small>}
                  </li>
                ))}
              </ul>
              {roomPreviewToolsEnabled && (
                <div className="room-preview-controls" aria-label="Local room preview tools">
                  <button
                    type="button"
                    className="sc-button sc-button--secondary sc-button--compact"
                    onClick={addDemoParticipant}
                    disabled={demoParticipants.length >= DEMO_PARTICIPANTS.length}
                    aria-label="Add demo participant"
                  >
                    <UserPlus size={13} aria-hidden="true" />
                    <span className="sc-button__label">Add demo</span>
                  </button>
                  <button
                    type="button"
                    className="sc-button sc-button--secondary sc-button--compact"
                    onClick={removeDemoParticipants}
                    disabled={demoParticipants.length === 0}
                    aria-label="Remove demo participants"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span className="sc-button__label">Remove demos</span>
                  </button>
                  <span>Local preview only</span>
                </div>
              )}
            </section>
          )}
        </div>

        {meeting && (
          <section className="conversation-call" aria-labelledby="conversation-call-title">
            <div className="call-remote-stage">
              <header>
                <div>
                  <span>Private one-to-one media</span>
                  <h2 id="conversation-call-title">Live conversation</h2>
                </div>
                <span className={`call-state ${incomingCall ? "incoming" : callState}`} aria-label="Call status">
                  {incomingCall
                    ? "Incoming call"
                    : callState === "connected"
                      ? "Connected"
                      : callState === "calling"
                        ? "Calling"
                        : callState === "connecting"
                          ? "Connecting"
                          : callState === "failed"
                            ? "Connection failed"
                            : "Not in a call"}
                </span>
              </header>
              <div className="remote-video-shell">
                <video
                  ref={remoteVideoRef}
                  data-testid="remote-video"
                  aria-label="Remote participant video"
                  autoPlay
                  playsInline
                  className={remoteStream ? "visible" : ""}
                />
                {!remoteStream && (
                  <div className="remote-video-empty">
                    <Video size={25} strokeWidth={1.5} aria-hidden="true" />
                    <strong>{incomingCall
                      ? `${incomingCallParticipant?.displayName ?? "A participant"} is calling`
                      : selectedCallParticipant
                        ? `Ready to call ${selectedCallParticipant.displayName}`
                        : "Waiting for another participant"}</strong>
                    <span>Remote video appears here after both browsers establish the peer connection.</span>
                  </div>
                )}
                {remoteStream && !remoteMediaState.videoEnabled && (
                  <div className="remote-media-paused"><VideoOff size={18} aria-hidden="true" /> Remote camera paused</div>
                )}
                {remoteStream && (
                  <div className="remote-media-state" aria-label="Remote media state">
                    <span>{remoteMediaState.audioEnabled ? "Remote microphone on" : "Remote microphone muted"}</span>
                    <span>{remoteMediaState.videoEnabled ? "Remote camera on" : "Remote camera paused"}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="call-control-panel">
              {incomingCall ? (
                <div className="incoming-call-actions">
                  <strong>{incomingCallParticipant?.displayName ?? "A participant"} wants to start a call.</strong>
                  <span>Accepting shares your active camera and selected microphone with that participant.</span>
                  <div>
                    <button
                      type="button"
                      className="sc-button sc-button--primary sc-button--compact"
                      onClick={acceptIncomingCall}
                      disabled={cameraState !== "on"}
                    >
                      <Phone size={14} aria-hidden="true" />
                      <span className="sc-button__label">Accept call</span>
                    </button>
                    <button
                      type="button"
                      className="sc-button sc-button--secondary sc-button--compact"
                      onClick={declineIncomingCall}
                    >
                      <PhoneOff size={14} aria-hidden="true" />
                      <span className="sc-button__label">Decline</span>
                    </button>
                  </div>
                  {cameraState !== "on" && <span>Turn on your camera before accepting.</span>}
                </div>
              ) : (
                <div className="call-primary-controls">
                  <label>
                    <span>Call participant</span>
                    <select
                      className="sc-select"
                      aria-label="Call participant"
                      value={selectedCallParticipantId}
                      onChange={(event) => setSelectedCallParticipantId(event.target.value)}
                      disabled={callActive || callParticipants.length === 0}
                    >
                      {callParticipants.length === 0 && <option value="">No participant available</option>}
                      {callParticipants.map((participant) => (
                        <option key={participant.participantId} value={participant.participantId}>
                          {participant.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="call-action-row">
                    {!callActive ? (
                      <button
                        type="button"
                        className="sc-button sc-button--primary"
                        onClick={startPeerCall}
                        disabled={!connected || cameraState !== "on" || !selectedCallParticipantId}
                      >
                        <Phone size={15} aria-hidden="true" />
                        <span className="sc-button__label">Start call</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="sc-button sc-button--danger"
                        onClick={() => {
                          stopCall("user_left", true);
                          setCallFeedback("Call ended.");
                          announce("Call ended.");
                        }}
                      >
                        <PhoneOff size={15} aria-hidden="true" />
                        <span className="sc-button__label">End call</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={microphoneEnabled ? "sc-button sc-button--selected" : "sc-button sc-button--secondary"}
                      onClick={toggleCallMicrophone}
                      disabled={!callActive}
                      aria-pressed={microphoneEnabled}
                      aria-label={microphoneEnabled ? "Mute call microphone" : "Unmute call microphone"}
                    >
                      {microphoneEnabled ? <Mic size={15} aria-hidden="true" /> : <MicOff size={15} aria-hidden="true" />}
                      <span className="sc-button__label">{microphoneEnabled ? "Mute" : "Unmute"}</span>
                    </button>
                    <button
                      type="button"
                      className={callVideoEnabled ? "sc-button sc-button--selected" : "sc-button sc-button--secondary"}
                      onClick={toggleCallVideo}
                      disabled={!callActive}
                      aria-pressed={callVideoEnabled}
                      aria-label={callVideoEnabled ? "Pause call camera" : "Resume call camera"}
                    >
                      {callVideoEnabled ? <Video size={15} aria-hidden="true" /> : <VideoOff size={15} aria-hidden="true" />}
                      <span className="sc-button__label">{callVideoEnabled ? "Pause video" : "Resume video"}</span>
                    </button>
                  </div>
                  {cameraState !== "on" && <span className="call-requirement">Turn on your camera to start a video call.</span>}
                </div>
              )}

              <details className="call-device-settings">
                <summary>Camera, microphone, and speaker</summary>
                <div>
                  <label>
                    <span>Camera</span>
                    <select
                      className="sc-select"
                      value={selectedCameraId}
                      onChange={(event) => setSelectedCameraId(event.target.value)}
                      disabled={cameraState === "on" || callActive}
                    >
                      {cameraDevices.length === 0 && <option value="">Browser default camera</option>}
                      {cameraDevices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Microphone</span>
                    <select
                      className="sc-select"
                      value={selectedMicrophoneId}
                      onChange={(event) => setSelectedMicrophoneId(event.target.value)}
                      disabled={callActive}
                    >
                      {microphoneDevices.length === 0 && <option value="">Browser default microphone</option>}
                      {microphoneDevices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Speaker</span>
                    <select
                      className="sc-select"
                      value={selectedSpeakerId}
                      onChange={(event) => setSelectedSpeakerId(event.target.value)}
                    >
                      {speakerDevices.length === 0 && <option value="">Browser default speaker</option>}
                      {speakerDevices.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <p className="call-privacy-note">
                Media travels browser-to-browser for this call and is not recorded by SignConnect. A TURN relay is still required for restrictive production networks.
              </p>
              {callFeedback && <div className="call-feedback">{callFeedback}</div>}
            </div>
          </section>
        )}

        <div className="studio-layout">
          <section className="capture-console" id="camera-workspace" tabIndex={-1} aria-label="Camera workspace">
            <header className="console-header">
              <div>
                <h2>Camera feed</h2>
                <span>{cameraEnabled ? "Live browser preview" : "Preview offline"}</span>
              </div>
            </header>

            <div className={`stage-viewport${signerGranted ? " is-recognizing" : ""}`}>
              <video ref={videoRef} autoPlay muted playsInline className={cameraEnabled ? "visible" : ""} />
              <canvas
                ref={overlayCanvasRef}
                className="landmark-overlay"
                aria-hidden="true"
                hidden={!trackingOverlayVisible}
              />
              <span className="recognition-scan" aria-hidden="true" />

              {cameraEnabled && (
                <div className="framing-guide" aria-hidden="true">
                  <span className="guide-corner top-left" />
                  <span className="guide-corner top-right" />
                  <span className="guide-corner bottom-left" />
                  <span className="guide-corner bottom-right" />
                </div>
              )}

              {!cameraEnabled && (
                <div className="camera-empty">
                  <span className="camera-empty-icon">
                    {cameraState === "requesting"
                      ? <LoaderCircle size={26} className="spin" aria-hidden="true" />
                      : <VideoOff size={26} strokeWidth={1.5} aria-hidden="true" />}
                  </span>
                  <strong>{cameraState === "requesting" ? "Opening camera" : "Camera is off"}</strong>
                  <span>{cameraState === "requesting" ? "Approve browser access to continue." : "Start a session, then enable your camera."}</span>
                </div>
              )}

              <div className="stage-statusbar">
                <span className={cameraEnabled ? "capture-state active" : "capture-state"}>
                  <span aria-hidden="true" /> {cameraEnabled ? "Camera active" : "Camera offline"}
                </span>
                {cameraEnabled && (
                  <span className={trackedHandCount > 0 ? "tracking-badge active" : "tracking-badge"}>
                    <Hand size={13} aria-hidden="true" />
                    {trackedHandCount > 0
                      ? `${trackedHandCount} hand${trackedHandCount === 1 ? "" : "s"} tracked`
                      : trackingLost
                        ? "Tracking lost"
                        : "Waiting for hands"}
                  </span>
                )}
              </div>

              {product.latestLocalCaption && (
                <div className="latest-sign-overlay" aria-label="Latest recognized sign">
                  <span>Latest recognized sign</span>
                  <strong>{product.latestLocalCaption.payload.text}</strong>
                  <div>
                    <span><Hand size={13} aria-hidden="true" /> You signed</span>
                    <time
                      dateTime={product.latestLocalCaption.occurredAt}
                      title={new Date(product.latestLocalCaption.occurredAt).toLocaleString()}
                    >
                      at {captionOccurredAt(product.latestLocalCaption.occurredAt)}
                    </time>
                    <span>{Math.round(product.latestLocalCaption.payload.confidence * 100)}% confidence</span>
                  </div>
                </div>
              )}

              <div className="gesture-overlay">
                <span>Recognition readiness</span>
                <strong>{signerRequestPending ? "Waiting for signer access" : readinessGuidance.title}</strong>
                <p>
                  {signerRequestPending
                    ? "The room must grant ownership before landmarks are transmitted."
                    : readinessGuidance.message}
                </p>
              </div>
            </div>

            <footer className="console-controls" aria-labelledby="recognition-controls-title">
              <div className="control-context">
                <Activity size={16} aria-hidden="true" />
                <div>
                  <strong id="recognition-controls-title">Capture controls</strong>
                  <span>{captureStatusText(recognition.captureStatus)}</span>
                </div>
              </div>

              <div className="control-actions">
                <button
                  className={trackingOverlayVisible
                    ? "sc-button sc-button--selected sc-button--compact"
                    : "sc-button sc-button--secondary sc-button--compact"}
                  type="button"
                  aria-label="Tracking overlay"
                  aria-pressed={trackingOverlayVisible}
                  onClick={() => setTrackingOverlayVisible((visible) => !visible)}
                >
                  <ScanLine size={14} aria-hidden="true" />
                  <span className="sc-button__label">
                    Tracking overlay: {trackingOverlayVisible ? "On" : "Off"}
                  </span>
                </button>

                <button
                  className={cameraEnabled
                    ? "sc-button sc-button--selected camera-control active"
                    : "sc-button sc-button--secondary camera-control"}
                  type="button"
                  onClick={toggleCamera}
                  disabled={cameraState === "requesting"}
                  aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                >
                  {cameraState === "requesting"
                    ? <LoaderCircle size={16} className="spin" aria-hidden="true" />
                    : cameraEnabled
                      ? <VideoOff size={16} aria-hidden="true" />
                      : <Video size={16} aria-hidden="true" />}
                  <span className="sc-button__label">
                    {cameraState === "requesting" ? "Requesting camera…" : cameraEnabled ? "Turn camera off" : "Turn camera on"}
                  </span>
                </button>

                <button
                  type="button"
                  className={signerGranted
                    ? "sc-button sc-button--accent recognition-toggle active"
                    : signerRequestPending
                      ? "sc-button sc-button--secondary recognition-toggle"
                    : "sc-button sc-button--signal recognition-toggle"}
                  onClick={toggleRecognition}
                  disabled={recognitionControlDisabled}
                  aria-describedby="recognition-disabled-reason recognition-disclosure"
                  aria-label={signerRequestPending ? "Cancel signer request" : undefined}
                >
                  {signerGranted
                    ? <Square size={12} fill="currentColor" aria-hidden="true" />
                    : signerRequestPending
                      ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
                    : <ScanLine size={15} aria-hidden="true" />}
                  <span className="sc-button__label">
                    {signerGranted
                      ? "Stop recognition"
                      : signerRequestPending
                        ? "Requesting access…"
                        : "Start recognition"}
                  </span>
                </button>
              </div>

              <span
                id="recognition-disabled-reason"
                className="control-explanation"
              >
                {signerGranted
                  ? "Landmark transmission is active."
                  : signerRequestPending
                    ? "Waiting for the room to grant active-signer access."
                    : product.signerFeedback
                      ?? (activeSigner && activeSigner.participantId !== currentParticipant?.id
                        ? `${activeSigner.displayName} is the active signer.`
                        : disabledReason)}
              </span>
            </footer>
          </section>

          <aside
            className="intelligence-panel"
            id="live-transcript"
            tabIndex={-1}
            role="region"
            aria-label="Live transcript"
          >
            <header className="panel-header">
              <div>
                <Captions size={17} aria-hidden="true" />
                <div>
                  <h2>Live transcript</h2>
                  <span>Confirmed output</span>
                </div>
              </div>
              <div className="transcript-header-actions">
                <span className="transcript-count" aria-label={`${transcriptEntries.length} transcript entries`}>
                  <span aria-label={`${product.captions.length} final captions`}>{transcriptEntries.length}</span>
                </span>
                <button
                  type="button"
                  className="sc-icon-button transcript-clear-action"
                  aria-label="Clear transcript"
                  title="Clear transcript"
                  onClick={clearTranscript}
                  disabled={transcriptEntries.length === 0}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </header>

            <section className="transcript-tools" aria-labelledby="spoken-transcript-title">
              <div className="speech-tool-copy">
                <span className={speechCaptureActive ? "speech-indicator active" : "speech-indicator"} aria-hidden="true">
                  {speechCaptureActive ? <Mic size={15} /> : <MicOff size={15} />}
                </span>
                <div>
                  <strong id="spoken-transcript-title">Spoken notes</strong>
                  <span>{speechStatusLabel}</span>
                </div>
              </div>
              <button
                type="button"
                className={speechCaptureActive
                  ? "sc-button sc-button--selected sc-button--compact"
                  : "sc-button sc-button--secondary sc-button--compact"}
                aria-label={speechCaptureActive ? "Stop spoken transcript" : "Start spoken transcript"}
                onClick={speechCaptureActive ? stopSpokenTranscript : startSpokenTranscript}
                disabled={!meeting}
                aria-describedby="spoken-transcript-disclosure"
              >
                {speechCaptureActive ? <MicOff size={13} aria-hidden="true" /> : <Mic size={13} aria-hidden="true" />}
                <span className="sc-button__label">{speechCaptureActive ? "Stop" : "Start"}</span>
              </button>
              <p id="spoken-transcript-disclosure">
                Opt-in local microphone capture. Your browser speech service may process audio; SignConnect does not store raw audio.
              </p>
              {speechFeedback && <div className="speech-feedback">{speechFeedback}</div>}
            </section>

            {mockNoticeVisible && (
              <div className="mock-model-notice" role="note">
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>Mock integration model.</strong> Output is synthetic and not validated SGSL recognition.</span>
              </div>
            )}

            {aslResearchNoticeVisible && !mockNoticeVisible && (
              <div className="mock-model-notice" role="note">
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>Local ASL research model.</strong> Supported signs: Hello, Thank you, Yes, No, Help, Repeat, Slower, Understand, Finished, and Goodbye. This is ASL, not SGSL.</span>
              </div>
            )}

            <div className="conversation-history">
              <div
                className="caption-list"
                ref={transcriptListRef}
                tabIndex={0}
                aria-label="Conversation history"
                onScroll={handleTranscriptScroll}
              >
              {transcriptEntries.length === 0 ? (
                <div className="caption-empty">
                  <span className="caption-empty-icon"><Captions size={21} strokeWidth={1.5} aria-hidden="true" /></span>
                  <strong>No transcript entries yet</strong>
                  <span>Confirmed signs, room messages, and opt-in spoken notes will appear here with their speaker and time.</span>
                </div>
              ) : transcriptEntries.map((transcriptEntry) => {
                if (transcriptEntry.kind === "chat") {
                  const { message } = transcriptEntry;
                  const isCurrentParticipant = currentParticipant !== null
                    && message.participantId === currentParticipant.id;
                  const sourceLabel = isCurrentParticipant ? "You" : message.payload.sourceDisplayName;
                  const sourceIdentity = isCurrentParticipant
                    ? currentParticipant.displayName
                    : message.payload.sourceDisplayName;
                  const typedAt = captionOccurredAt(message.occurredAt);
                  return (
                    <article
                      className="caption-entry chat-entry"
                      key={message.messageId}
                      aria-label={`${sourceLabel} typed ${message.payload.text} at ${typedAt}`}
                      data-participant-tone={participantTone(message.participantId, isCurrentParticipant)}
                    >
                      <div className="caption-meta">
                        <span className="caption-source">
                          <span className="participant-mark" aria-hidden="true">{participantInitials(sourceIdentity)}</span>
                          <MessageSquare size={13} aria-hidden="true" />
                          {sourceLabel} typed
                        </span>
                        <time dateTime={message.occurredAt} title={new Date(message.occurredAt).toLocaleString()}>
                          at {typedAt}
                        </time>
                      </div>
                      <p>{message.payload.text}</p>
                      <div className="caption-details"><span>Room message</span></div>
                    </article>
                  );
                }
                if (transcriptEntry.kind === "speech") {
                  const { entry } = transcriptEntry;
                  const isCurrentParticipant = currentParticipant !== null
                    && entry.sourceDisplayName === currentParticipant.displayName
                    && !entry.simulated;
                  const sourceLabel = isCurrentParticipant ? "You" : entry.sourceDisplayName;
                  const spokenAt = captionOccurredAt(entry.occurredAt);
                  return (
                    <article
                      className="caption-entry speech-entry"
                      key={entry.id}
                      aria-label={`${sourceLabel} spoke ${entry.text} at ${spokenAt}`}
                      data-participant-tone={participantTone(entry.sourceDisplayName, isCurrentParticipant)}
                    >
                      <div className="caption-meta">
                        <span className="caption-source">
                          <span className="participant-mark" aria-hidden="true">{participantInitials(entry.sourceDisplayName)}</span>
                          <Mic size={13} aria-hidden="true" />
                          {sourceLabel} spoke
                        </span>
                        <time dateTime={entry.occurredAt} title={new Date(entry.occurredAt).toLocaleString()}>
                          at {spokenAt}
                        </time>
                      </div>
                      <p>{entry.text}</p>
                      <div className="caption-details">
                        <span>Local microphone</span>
                        {entry.simulated && <span>Demo preview</span>}
                      </div>
                    </article>
                  );
                }

                const { caption } = transcriptEntry;
                const isCurrentParticipant = currentParticipant !== null
                  && caption.participantId === currentParticipant.id;
                const sourceName = caption.payload.sourceDisplayName
                  ?? (isCurrentParticipant ? currentParticipant?.displayName ?? "You" : "Participant");
                const sourceLabel = captionSourceLabel(sourceName, isCurrentParticipant);
                const signedAt = captionOccurredAt(caption.occurredAt);
                return (
                  <article
                    className="caption-entry sign-entry"
                    key={caption.captionId ?? `${caption.streamId}-${caption.sequence}`}
                    aria-label={`${sourceLabel} signed ${caption.payload.text} at ${signedAt}`}
                    data-participant-tone={participantTone(caption.participantId ?? sourceName, isCurrentParticipant)}
                  >
                    <div className="caption-meta">
                      <span className="caption-source">
                        <span className="participant-mark" aria-hidden="true">{participantInitials(sourceName)}</span>
                        <Hand size={13} aria-hidden="true" />
                        {sourceLabel} signed
                      </span>
                      <time dateTime={caption.occurredAt} title={new Date(caption.occurredAt).toLocaleString()}>
                        at {signedAt}
                      </time>
                    </div>
                    <p>{caption.payload.text}</p>
                    <div className="caption-details">
                      <span className="confidence"><Check size={11} aria-hidden="true" /> {Math.round(caption.payload.confidence * 100)}% confidence</span>
                      <span>{caption.payload.modelVersion}</span>
                      {caption.payload.mockModel && <span>Mock model</span>}
                    </div>
                  </article>
                );
              })}
              </div>
              {unreadTranscriptCount > 0 && (
                <button
                  type="button"
                  className="sc-button sc-button--secondary sc-button--compact transcript-jump-action"
                  aria-label={`${unreadTranscriptCount} new ${unreadTranscriptCount === 1 ? "message" : "messages"}. Jump to latest`}
                  onClick={() => scrollTranscriptToLatest(true)}
                >
                  <MessageSquare size={13} aria-hidden="true" />
                  <span className="sc-button__label">
                    {unreadTranscriptCount} new {unreadTranscriptCount === 1 ? "message" : "messages"}
                  </span>
                </button>
              )}
            </div>

            <form className="message-composer" onSubmit={sendChatMessage}>
              <label htmlFor="room-message">Message the room</label>
              <div className="message-composer-row">
                <textarea
                  id="room-message"
                  className="sc-textarea"
                  rows={1}
                  maxLength={500}
                  value={chatDraft}
                  onChange={(event) => {
                    setChatDraft(event.target.value);
                    setChatFeedback(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Type a reply…"
                  disabled={!connected}
                  aria-describedby="room-message-hint"
                />
                <button
                  type="submit"
                  className="sc-button sc-button--primary sc-button--compact"
                  aria-label="Send message"
                  disabled={!connected || chatDraft.trim().length === 0}
                >
                  <Send size={13} aria-hidden="true" />
                  <span className="sc-button__label">Send</span>
                </button>
              </div>
              <div className="message-composer-meta" id="room-message-hint">
                <span>{connected ? "Enter to send · Shift+Enter for a new line" : "Connect to a room to send messages"}</span>
                <span>{Array.from(chatDraft).length}/500</span>
              </div>
              {chatFeedback && <div className="message-feedback" role="status">{chatFeedback}</div>}
            </form>

            <section
              className="system-health"
              id="recognition-status"
              tabIndex={-1}
              aria-label="Recognition status"
            >
              <div className="system-health-header">
                <strong>Recognition status</strong>
                <span className={`health-light ${recognition.captureStatus}`} aria-hidden="true" />
              </div>
              <div className="recognition-status-summary">
                <span>Current state</span>
                <div className="recognition-status-copy" aria-label="Camera readiness">
                  <strong>{readinessGuidance.title}</strong>
                  <p>{readinessGuidance.message}</p>
                </div>
              </div>
              <details className="recognition-diagnostics">
                <summary>
                  <span>Technical details</span>
                  <span>4 checks</span>
                </summary>
                <dl>
                  <div>
                    <dt>Landmark capture</dt>
                    <dd>{captureHealthLabel(recognition.captureStatus)}</dd>
                  </div>
                  <div>
                    <dt>Browser vision</dt>
                    <dd>{landmarkExtractorLabel}</dd>
                  </div>
                  <div>
                    <dt>Inference service</dt>
                    <dd aria-label="Recognition service status">{product.serviceStatus}</dd>
                  </div>
                  <div>
                    <dt>Signer access</dt>
                    <dd>{signerGranted
                      ? "Granted to you"
                      : signerRequestPending
                        ? "Awaiting room grant"
                        : activeSigner
                          ? `${activeSigner.displayName} is signing`
                          : "Available"}</dd>
                  </div>
                </dl>
              </details>
              {product.recognitionFeedback && <div className="recognition-feedback">{product.recognitionFeedback}</div>}
              {product.protocolFeedback && <div className="protocol-feedback">{product.protocolFeedback}</div>}
              <div className="workspace-help" id="workspace-help" tabIndex={-1}>
                <CircleHelp size={15} aria-hidden="true" />
                <span>
                  <strong>Recognition help</strong>
                  Keep your upper body and hands inside the camera guide. Only landmarks are sent for sign inference; raw video stays in this browser.
                </span>
              </div>
            </section>

          </aside>
        </div>

        <p id="recognition-disclosure" className="sr-only">
          Starting recognition consents to transient hand and body landmark transmission; raw video is not transmitted.
        </p>
        {(meeting || !error) && (
          <div className="sr-only" role="status" aria-label="Meeting announcements" aria-live="polite" aria-atomic="true">
            {liveAnnouncement}
          </div>
        )}

        {SIMULATOR_ENABLED && <RecognitionSimulator connected={connected} send={realtime.send} />}
      </section>
    );
  }

  MeetingAppConfigured.displayName = "MeetingApp";
  return MeetingAppConfigured;
}

const MeetingApp = createMeetingApp();

export default MeetingApp;
