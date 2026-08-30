import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  Activity,
  Captions,
  Check,
  CircleAlert,
  Copy,
  Hand,
  LoaderCircle,
  LogIn,
  Plus,
  Radio,
  ScanLine,
  Square,
  Users,
  Video,
  VideoOff
} from "lucide-react";

import {
  createMeeting,
  joinMeeting,
  MeetingRequestError,
  type CaptionEvent,
  type Meeting,
  type Participant,
  type RoomParticipant,
  type ServerRealtimeEvent,
  type SignerReleaseEvent
} from "./api";
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
import { ToastViewport, useToastQueue } from "./ToastViewport";
import "./meeting.css";

type CameraState = "off" | "requesting" | "on" | "permission-denied" | "no-device" | "error";

type ProductState = {
  captions: CaptionEvent[];
  latestRecognitionOutcome: "recognized" | "not-recognized" | null;
  recognitionFeedback: string | null;
  serviceStatus: string;
  protocolFeedback: string | null;
  signerFeedback: string | null;
  mockModelActive: boolean;
};

type ProductAction =
  | { type: "server-event"; event: ServerRealtimeEvent }
  | { type: "parse-issue"; reason: "malformed" | "unsupported" }
  | { type: "room-order-issue" }
  | { type: "gesture-dispatched" }
  | { type: "signer-feedback"; message: string | null }
  | { type: "reset-session" };

const INITIAL_PRODUCT_STATE: ProductState = {
  captions: [],
  latestRecognitionOutcome: null,
  recognitionFeedback: null,
  serviceStatus: "Recognition service is waiting.",
  protocolFeedback: null,
  signerFeedback: null,
  mockModelActive: false
};

const SIMULATOR_ENABLED = process.env.RECOGNITION_SIMULATOR_ENABLED === "true";

function productReducer(state: ProductState, action: ProductAction): ProductState {
  if (action.type === "reset-session") return { ...INITIAL_PRODUCT_STATE };
  if (action.type === "room-order-issue") {
    return { ...state, protocolFeedback: "Some room updates arrived out of order. The newest room state is shown." };
  }
  if (action.type === "gesture-dispatched") {
    return { ...state, latestRecognitionOutcome: null };
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
    return {
      ...state,
      captions: [...state.captions, event],
      latestRecognitionOutcome: "recognized",
      recognitionFeedback: null,
      mockModelActive: state.mockModelActive || event.payload.mockModel
    };
  }
  if (event.type === "recognition.unknown") {
    const reason = event.payload.reason === "LOW_CONFIDENCE"
      ? "The sign was not recognized with enough confidence."
      : "The sign was not recognized because tracking was unstable.";
    return {
      ...state,
      recognitionFeedback: reason,
      latestRecognitionOutcome: "not-recognized",
      mockModelActive: state.mockModelActive || event.payload.mockModel
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
  return {
    ...state,
    serviceStatus,
    mockModelActive: state.mockModelActive || event.payload.mockModel === true
  };
}

export interface MeetingAppComposition {
  socketFactory?: (url: string) => RealtimeSocketLike;
  retryScheduler?: RealtimeRetryScheduler;
  maximumBufferedAmount?: number;
  captureOptions?: Omit<UseLandmarkCaptureOptions, "onStatus" | "onGestureCandidate">;
  clock?: RecognitionClock;
  trackingAnnouncementDelayMs?: number;
  requestIdFactory?: () => string;
}

function cameraFailure(error: unknown): { state: CameraState; message: string } {
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return { state: "no-device", message: "No camera device was found." };
  }
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return { state: "permission-denied", message: "Camera permission was not granted." };
  }
  return { state: "error", message: "The camera could not be started." };
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
  recognitionOutcome: ProductState["latestRecognitionOutcome"]
): CameraReadinessGuidance {
  const title = mapCanonicalApplicationState({
    camera: cameraState === "requesting" ? "initializing" : cameraState === "on" ? "on" : "off",
    recognitionEnabled,
    hasFrame: frame !== null,
    trackingQuality: frame?.trackingQuality.state ?? null,
    calibrationReady: frame?.calibration.state === "ready",
    gesturePhase: frame?.gesturePhase ?? null,
    recognitionOutcome
  });
  switch (title) {
    case "Camera off":
      return { title, message: "Turn on the camera to position yourself before recognition." };
    case "Camera initializing":
      return { title, message: cameraState === "requesting"
        ? "Approve camera access, then keep your upper body in view."
        : recognitionEnabled
          ? "Keep your shoulders and both hands inside the guide while positioning completes."
          : "Start recognition when you are ready to check positioning." };
    case "No person detected":
      return { title, message: "Sit or stand naturally in the center of the camera guide." };
    case "Upper body not fully visible":
      return { title, message: "Move back until both shoulders, elbows, and wrists are visible." };
    case "Left hand missing":
      return { title, message: "Bring your left hand into the camera guide." };
    case "Right hand missing":
      return { title, message: "Bring your right hand into the camera guide." };
    case "Hands too close to the frame edge":
      return { title, message: "Move both hands away from the edge of the guide." };
    case "Lighting or tracking quality too poor":
      return { title, message: "Face the camera, improve lighting, and keep your upper body steady." };
    case "Gesture in progress":
      return { title, message: "Continue naturally until your hands settle." };
    case "Processing":
      return { title, message: "The completed gesture is being recognized." };
    case "Sign recognized":
      return { title, message: "The latest completed gesture produced a final caption." };
    case "Sign not recognized":
      return { title, message: "Try the gesture again with both hands clearly visible." };
    default:
      return { title, message: "Shoulders and both hands are visible and calibrated." };
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

type DemoGesture = {
  displayName: string;
  confidence: number;
  handedness: "Left" | "Right" | null;
};

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
    const [demoGesture, setDemoGesture] = useState<DemoGesture | null>(null);
    const [signerOwnership, setSignerOwnership] = useState<SignerOwnershipState>(INITIAL_SIGNER_STATE);
    const [liveAnnouncement, setLiveAnnouncement] = useState("");
    const [product, dispatch] = useReducer(productReducer, INITIAL_PRODUCT_STATE);
    const { toasts, pushToast, dismissToast } = useToastQueue();
    const announce = useCallback((message: string) => setLiveAnnouncement(message), []);
    const notify = useCallback((notice: Parameters<typeof pushToast>[0]) => {
      pushToast(notice);
      announce(`${notice.title}. ${notice.message}`);
    }, [announce, pushToast]);
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const browserLocalFrameRef = useRef<BrowserLocalVisionFrame | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const mediaTrackEndedListenersRef = useRef(new Map<MediaStreamTrack, EventListener>());
    const recognitionStreamRef = useRef<string | null>(null);
    const recentlyStoppedStreamRef = useRef<string | null>(null);
    const mountedRef = useRef(true);
    const cameraRequestGenerationRef = useRef(0);
    const meetingRequestGenerationRef = useRef(0);
    const lastStableGestureTimestampRef = useRef(Number.NEGATIVE_INFINITY);
    const roomGenerationRef = useRef(0);
    const lastRoomSequenceRef = useRef(-1);
    const signerCommandGenerationRef = useRef(-1);
    const signerCommandSequenceRef = useRef(0);
    const signerCommandTimestampRef = useRef(-1);
    const signerOwnershipRef = useRef(signerOwnership);
    const currentParticipantRef = useRef(currentParticipant);
    const revokeRecognitionRef = useRef<() => void>(() => undefined);
    const stopMediaRef = useRef<() => void>(() => undefined);

    signerOwnershipRef.current = signerOwnership;
    currentParticipantRef.current = currentParticipant;

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
      dispatch({ type: "server-event", event });
    }, []);

    const realtime = useRealtimeSession({
      socketFactory: composition.socketFactory,
      retryScheduler: composition.retryScheduler,
      maximumBufferedAmount: composition.maximumBufferedAmount,
      onEvent: acceptServerEvent,
      onParseIssue: (issue) => dispatch({ type: "parse-issue", reason: issue.reason })
    });

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
      onGestureDispatched: () => dispatch({ type: "gesture-dispatched" }),
      onStreamChange: (streamId) => {
        const previousStreamId = recognitionStreamRef.current;
        if (streamId === null && previousStreamId !== null) {
          recentlyStoppedStreamRef.current = previousStreamId;
        } else if (streamId !== null) {
          recentlyStoppedStreamRef.current = null;
        }
        recognitionStreamRef.current = streamId;
      },
      onOwnershipReleaseNeeded: releaseSigner
    });
    browserLocalFrameRef.current = recognition.browserLocalFrame;
    revokeRecognitionRef.current = recognition.revoke;

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
        if (!recognition.enabledByUser) setDemoGesture(null);
        return;
      }

      drawBrowserLocalOverlay(canvas, video, frame);
      const gesture = frame.gesture;
      if (gesture?.stable) {
        lastStableGestureTimestampRef.current = frame.timestampMs;
        setDemoGesture((current) => {
          if (current
            && current.displayName === gesture.displayName
            && current.handedness === gesture.handedness
            && Math.abs(current.confidence - gesture.confidence) < 0.03) {
            return current;
          }
          return {
            displayName: gesture.displayName,
            confidence: gesture.confidence,
            handedness: gesture.handedness
          };
        });
      } else if (frame.timestampMs - lastStableGestureTimestampRef.current > 700) {
        setDemoGesture(null);
      }
    }, [recognition.browserLocalFrame, recognition.enabledByUser, trackingOverlayVisible]);

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
      const stream = mediaStreamRef.current;
      mediaStreamRef.current = null;
      mediaTrackEndedListenersRef.current.forEach((listener, track) => {
        track.removeEventListener("ended", listener);
      });
      mediaTrackEndedListenersRef.current.clear();
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      clearOverlay(overlayCanvasRef.current);
      lastStableGestureTimestampRef.current = Number.NEGATIVE_INFINITY;
      setDemoGesture(null);
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
        stopMedia();
      };
    }, [stopMedia]);

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
            facingMode: "user"
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
    const mockNoticeVisible = recognition.enabledByUser || product.mockModelActive;
    const browserLocalFrame = recognition.browserLocalFrame;
    const readinessGuidance = cameraReadinessGuidance(
      cameraState,
      recognition.enabledByUser,
      browserLocalFrame,
      product.latestRecognitionOutcome
    );
    const trackedHandCount = browserLocalFrame?.hands.length ?? 0;
    const trackingLost = recognition.enabledByUser
      && (recognition.captureStatus === "no-hands" || recognition.captureStatus === "low-quality");
    const localModelLabel = !recognition.enabledByUser
      ? "Loads when recognition starts"
      : browserLocalFrame?.gestureModel === "ready"
        ? "Generic gesture model ready"
        : browserLocalFrame?.gestureModel === "unavailable"
          ? "Landmark-only fallback active"
          : "Loading local gesture model";
    const previousReadinessTitleRef = useRef("");
    useEffect(() => {
      if (!recognition.enabledByUser || previousReadinessTitleRef.current === readinessGuidance.title) return;
      previousReadinessTitleRef.current = readinessGuidance.title;
      announce(readinessGuidance.title + ". " + readinessGuidance.message);
    }, [announce, readinessGuidance.message, readinessGuidance.title, recognition.enabledByUser]);

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
            <section className="room-entry-panel" aria-labelledby="room-entry-title">
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
            <section className="room-presence-bar" aria-label="Room participants">
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
                <span>{participants.length} participant{participants.length === 1 ? "" : "s"}</span>
              </div>
              <ul className="participant-list" aria-label="People in this room">
                {participants.map((roomParticipant) => (
                  <li key={roomParticipant.participantId}>
                    <span className="participant-avatar" aria-hidden="true">
                      {roomParticipant.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{roomParticipant.displayName}</span>
                    {roomParticipant.participantId === currentParticipant?.id && <em>You</em>}
                    {roomParticipant.role === "HOST" && <small>Host</small>}
                    {roomParticipant.activeSigner && <small>Signer</small>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="studio-layout">
          <section className="capture-console" aria-label="Camera workspace">
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

              <div className="gesture-overlay">
                <span>Local interpretation</span>
                <strong>
                  {demoGesture
                    ? demoGesture.displayName
                    : signerRequestPending
                      ? "Waiting for signer access"
                      : readinessGuidance.title}
                </strong>
                <p>
                  {demoGesture
                    ? `${Math.round(demoGesture.confidence * 100)}% confidence${demoGesture.handedness ? `, ${demoGesture.handedness} hand` : ""}`
                    : signerRequestPending
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

          <aside className="intelligence-panel" role="region" aria-label="Live transcript">
            <header className="panel-header">
              <div>
                <Captions size={17} aria-hidden="true" />
                <div>
                  <h2>Live transcript</h2>
                  <span>Confirmed output</span>
                </div>
              </div>
              <span aria-label={`${product.captions.length} final captions`}>{product.captions.length}</span>
            </header>

            {mockNoticeVisible && (
              <div className="mock-model-notice" role="note">
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>Mock integration model.</strong> Output is synthetic and not validated SGSL recognition.</span>
              </div>
            )}

            <div className="caption-list">
              {product.captions.length === 0 ? (
                <div className="caption-empty">
                  <span className="caption-empty-icon"><Captions size={21} strokeWidth={1.5} aria-hidden="true" /></span>
                  <strong>No captions yet</strong>
                  <span>Supported signs appear here after the inference service confirms them.</span>
                </div>
              ) : product.captions.map((caption) => {
                const isCurrentParticipant = currentParticipant !== null
                  && caption.participantId === currentParticipant.id;
                const sourceName = caption.payload.sourceDisplayName
                  ?? (isCurrentParticipant ? currentParticipant?.displayName ?? "You" : "Participant");
                return (
                  <article className="caption-entry" key={caption.captionId ?? `${caption.streamId}-${caption.sequence}`}>
                    <div className="caption-meta">
                      <span>
                        {sourceName}
                        {isCurrentParticipant ? " (you)" : ""}
                      </span>
                      <time dateTime={caption.occurredAt}>
                        {new Date(caption.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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

            <section className="system-health" aria-label="Recognition status">
              <div className="system-health-header">
                <strong>Recognition status</strong>
                <span className={`health-light ${recognition.captureStatus}`} aria-hidden="true" />
              </div>
              <dl>
                <div>
                  <dt>Camera readiness</dt>
                  <dd className="readiness-detail" aria-label="Camera readiness">
                    <strong>{readinessGuidance.title}</strong>
                    <span>{readinessGuidance.message}</span>
                  </dd>
                </div>
                <div>
                  <dt>Landmark capture</dt>
                  <dd>{captureHealthLabel(recognition.captureStatus)}</dd>
                </div>
                <div>
                  <dt>Local model</dt>
                  <dd>{localModelLabel}</dd>
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
              <div className="demo-disclosure">
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>Generic gesture preview.</strong> This is not validated SGSL recognition.</span>
              </div>
              {product.recognitionFeedback && <div className="recognition-feedback">{product.recognitionFeedback}</div>}
              {product.protocolFeedback && <div className="protocol-feedback">{product.protocolFeedback}</div>}
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
