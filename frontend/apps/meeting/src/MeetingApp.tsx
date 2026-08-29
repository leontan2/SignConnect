import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  Activity,
  Captions,
  Check,
  CircleAlert,
  Hand,
  LoaderCircle,
  Radio,
  ScanLine,
  Square,
  Video,
  VideoOff
} from "lucide-react";

import {
  createMeeting,
  type CaptionEvent,
  type ServerRealtimeEvent
} from "./api";
import {
  type RealtimeRetryScheduler,
  type RealtimeSocketLike
} from "./recognition/RealtimeClient";
import type { BrowserLocalVisionFrame, LandmarkCaptureStatus } from "./recognition/contracts";
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
  recognitionFeedback: string | null;
  serviceStatus: string;
  protocolFeedback: string | null;
  mockModelActive: boolean;
};

type ProductAction =
  | { type: "server-event"; event: ServerRealtimeEvent }
  | { type: "parse-issue"; reason: "malformed" | "unsupported" }
  | { type: "reset-feedback" };

const INITIAL_PRODUCT_STATE: ProductState = {
  captions: [],
  recognitionFeedback: null,
  serviceStatus: "Recognition service is waiting.",
  protocolFeedback: null,
  mockModelActive: false
};

const SIMULATOR_ENABLED = process.env.RECOGNITION_SIMULATOR_ENABLED === "true";

function productReducer(state: ProductState, action: ProductAction): ProductState {
  if (action.type === "reset-feedback") {
    return { ...state, recognitionFeedback: null, protocolFeedback: null };
  }
  if (action.type === "parse-issue") {
    const protocolFeedback = action.reason === "unsupported"
      ? "Unsupported realtime event was ignored."
      : state.protocolFeedback ?? "Malformed realtime event was ignored.";
    return { ...state, protocolFeedback };
  }

  const event = action.event;
  if (event.type === "caption.final") {
    return {
      ...state,
      captions: [...state.captions, event],
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
      mockModelActive: state.mockModelActive || event.payload.mockModel
    };
  }

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
  captureOptions?: Omit<UseLandmarkCaptureOptions, "consumer" | "onStatus">;
  clock?: RecognitionClock;
  trackingAnnouncementDelayMs?: number;
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

function connectionLabel(status: string, recovered: boolean, retryDelayMs?: number): string {
  if (status === "connected") return recovered ? "Connection recovered" : "Connected";
  if (status === "connecting") return "Connecting";
  if (status === "reconnecting") {
    return retryDelayMs === undefined ? "Reconnecting" : `Reconnecting in ${retryDelayMs} ms`;
  }
  return "Not connected";
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
  if (width <= 0 || height <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    clearOverlay(canvas);
    return;
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.round(width * pixelRatio);
  const targetHeight = Math.round(height * pixelRatio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const coverScale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const renderedWidth = video.videoWidth * coverScale;
  const renderedHeight = video.videoHeight * coverScale;
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
    const [meeting, setMeeting] = useState<Awaited<ReturnType<typeof createMeeting>> | null>(null);
    const [meetingRequestPending, setMeetingRequestPending] = useState(false);
    const [cameraState, setCameraState] = useState<CameraState>("off");
    const [error, setError] = useState<string | null>(null);
    const [demoGesture, setDemoGesture] = useState<DemoGesture | null>(null);
    const [product, dispatch] = useReducer(productReducer, INITIAL_PRODUCT_STATE);
    const { toasts, pushToast, dismissToast } = useToastQueue();
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const mediaTrackEndedListenersRef = useRef(new Map<MediaStreamTrack, EventListener>());
    const recognitionStreamRef = useRef<string | null>(null);
    const recentlyStoppedStreamRef = useRef<string | null>(null);
    const mountedRef = useRef(true);
    const cameraRequestGenerationRef = useRef(0);
    const meetingRequestGenerationRef = useRef(0);
    const lastStableGestureTimestampRef = useRef(Number.NEGATIVE_INFINITY);

    const acceptServerEvent = useCallback((event: ServerRealtimeEvent) => {
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

    const recognition = useSignRecognition({
      cameraEnabled: cameraState === "on",
      getVideo: () => videoRef.current,
      realtimeState: realtime.state,
      send: realtime.send,
      isUnderPressure: realtime.isUnderPressure,
      captureOptions: composition.captureOptions,
      clock: composition.clock,
      trackingAnnouncementDelayMs: composition.trackingAnnouncementDelayMs,
      onStreamChange: (streamId) => {
        const previousStreamId = recognitionStreamRef.current;
        if (streamId === null && previousStreamId !== null) {
          recentlyStoppedStreamRef.current = previousStreamId;
        } else if (streamId !== null) {
          recentlyStoppedStreamRef.current = null;
        }
        recognitionStreamRef.current = streamId;
      }
    });

    const previousRealtimeStatusRef = useRef(realtime.state.status);
    useEffect(() => {
      const previousStatus = previousRealtimeStatusRef.current;
      const currentStatus = realtime.state.status;

      if (currentStatus === "connected" && previousStatus !== "connected") {
        pushToast({
          key: "realtime-connection",
          tone: "success",
          title: realtime.state.recovered || previousStatus === "reconnecting"
            ? "Connection restored"
            : "Session connected",
          message: meeting ? `Room ${meeting.id.slice(0, 8)} is ready.` : "The realtime session is ready."
        });
      } else if (currentStatus === "reconnecting" && previousStatus === "connected") {
        pushToast({
          key: "realtime-connection",
          tone: "info",
          title: "Connection interrupted",
          message: "SignConnect is attempting to reconnect."
        });
      }

      previousRealtimeStatusRef.current = currentStatus;
    }, [meeting, pushToast, realtime.state.recovered, realtime.state.status]);

    useEffect(() => {
      const frame = recognition.browserLocalFrame;
      const canvas = overlayCanvasRef.current;
      const video = videoRef.current;
      if (!frame || !canvas || !video) {
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
    }, [recognition.browserLocalFrame, recognition.enabledByUser]);

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
        pushToast({
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
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
            pushToast({
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
        pushToast({
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
        pushToast({
          key: "camera",
          tone: "error",
          title: "Camera unavailable",
          message: "Check browser camera access and try again."
        });
      }
    }

    async function startMeeting() {
      const requestGeneration = ++meetingRequestGenerationRef.current;
      setMeetingRequestPending(true);
      setError(null);
      dispatch({ type: "reset-feedback" });
      try {
        const createdMeeting = await createMeeting("Accessible team sync");
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        setMeeting(createdMeeting);
        realtime.connect(createdMeeting.id);
      } catch {
        if (!mountedRef.current || requestGeneration !== meetingRequestGenerationRef.current) return;
        setError("The meeting service is unavailable.");
        pushToast({
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

    function toggleRecognition() {
      if (recognition.enabledByUser) {
        recognition.stop();
        pushToast({
          key: "recognition",
          tone: "info",
          title: "Capture ended",
          message: "Recognition is no longer running."
        });
      } else if (recognition.start()) {
        pushToast({
          key: "recognition",
          tone: "success",
          title: "Recognition live",
          message: "Hold a supported sign inside the camera guide."
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
      realtime.state.retryDelayMs
    );
    const cameraEnabled = cameraState === "on";
    const mockNoticeVisible = recognition.enabledByUser || product.mockModelActive;
    const browserLocalFrame = recognition.browserLocalFrame;
    const trackedHandCount = browserLocalFrame?.hands.length ?? 0;
    const localModelLabel = !recognition.enabledByUser
      ? "Loads when recognition starts"
      : browserLocalFrame?.gestureModel === "ready"
        ? "Generic gesture model ready"
        : browserLocalFrame?.gestureModel === "unavailable"
          ? "Landmark-only fallback active"
          : "Loading local gesture model";

    return (
      <section className="studio-workspace" aria-labelledby="meeting-title">
        <ToastViewport toasts={toasts} onDismiss={dismissToast} />
        <header className="studio-header">
          <div className="studio-heading">
            <span>Live workspace</span>
            <h1 id="meeting-title">Recognition studio</h1>
          </div>

          <div className="session-cluster">
            <div className={`connection-state ${realtime.state.status}`} aria-live="polite">
              {(realtime.state.status === "connecting" || realtime.state.status === "reconnecting") && (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              )}
              {connected && <Radio size={14} aria-hidden="true" />}
              {realtime.state.status === "idle" && <span className="idle-dot" aria-hidden="true" />}
              {currentConnectionLabel}
            </div>
            <span className="room-reference">{meeting ? `Room ${meeting.id.slice(0, 8)}` : "No active room"}</span>
            <button
              type="button"
              className={`sc-button sc-button--ink session-control${connected ? " sc-button--confirmed" : ""}`}
              onClick={startMeeting}
              disabled={meetingRequestPending || realtime.state.status !== "idle" || meeting !== null}
            >
              {connected ? <Check size={15} aria-hidden="true" /> : <Radio size={15} aria-hidden="true" />}
              <span className="sc-button__label">
                {connected
                  ? "Session active"
                  : realtime.state.status === "reconnecting"
                    ? "Reconnecting…"
                    : meetingRequestPending || realtime.state.status === "connecting"
                      ? "Connecting…"
                      : "Start session"}
              </span>
            </button>
          </div>
        </header>

        {error && (
          <div className="meeting-alert" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="studio-layout">
          <section className="capture-console" aria-label="Camera workspace">
            <header className="console-header">
              <div>
                <h2>Camera feed</h2>
                <span>{cameraEnabled ? "Live browser preview" : "Preview offline"}</span>
              </div>
            </header>

            <div className={`stage-viewport${recognition.enabledByUser ? " is-recognizing" : ""}`}>
              <video ref={videoRef} autoPlay muted playsInline className={cameraEnabled ? "visible" : ""} />
              <canvas ref={overlayCanvasRef} className="landmark-overlay" aria-hidden="true" />
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
                    {trackedHandCount > 0 ? `${trackedHandCount} hand${trackedHandCount === 1 ? "" : "s"} tracked` : "Waiting for hands"}
                  </span>
                )}
              </div>

              <div className="gesture-overlay" role="status" aria-live="polite" aria-atomic="true">
                <span>Local interpretation</span>
                <strong>
                  {demoGesture
                    ? demoGesture.displayName
                    : recognition.enabledByUser
                      ? "Show a clear hand gesture"
                      : "Recognition is ready"}
                </strong>
                <p>
                  {demoGesture
                    ? `${Math.round(demoGesture.confidence * 100)}% confidence${demoGesture.handedness ? `, ${demoGesture.handedness} hand` : ""}`
                    : recognition.enabledByUser
                      ? "Hold the gesture steady inside the guide."
                      : "Enable the camera and recognition to begin."}
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
                  className={recognition.enabledByUser
                    ? "sc-button sc-button--accent recognition-toggle active"
                    : "sc-button sc-button--signal recognition-toggle"}
                  onClick={toggleRecognition}
                  disabled={recognitionControlDisabled}
                  aria-describedby="recognition-disabled-reason recognition-disclosure"
                >
                  {recognition.enabledByUser
                    ? <Square size={12} fill="currentColor" aria-hidden="true" />
                    : <ScanLine size={15} aria-hidden="true" />}
                  <span className="sc-button__label">
                    {recognition.enabledByUser ? "Stop recognition" : "Start recognition"}
                  </span>
                </button>
              </div>

              <span id="recognition-disabled-reason" className="control-explanation">
                {recognition.enabledByUser ? "Landmark transmission is active." : disabledReason}
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

            <div className="caption-list" aria-live="polite">
              {product.captions.length === 0 ? (
                <div className="caption-empty">
                  <span className="caption-empty-icon"><Captions size={21} strokeWidth={1.5} aria-hidden="true" /></span>
                  <strong>No captions yet</strong>
                  <span>Supported signs appear here after the inference service confirms them.</span>
                </div>
              ) : product.captions.map((caption) => (
                <article className="caption-entry" key={`${caption.streamId}-${caption.sequence}`}>
                  <div className="caption-meta">
                    <span>You</span>
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
              ))}
            </div>

            <section className="system-health" aria-label="Recognition status">
              <div className="system-health-header">
                <strong>Recognition status</strong>
                <span className={`health-light ${recognition.captureStatus}`} aria-hidden="true" />
              </div>
              <dl>
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
                  <dd role="status" aria-label="Recognition service status" aria-live="polite">{product.serviceStatus}</dd>
                </div>
              </dl>
              <div className="demo-disclosure">
                <CircleAlert size={14} aria-hidden="true" />
                <span><strong>Generic gesture preview.</strong> This is not validated SGSL recognition.</span>
              </div>
              {product.recognitionFeedback && <div className="recognition-feedback" role="status">{product.recognitionFeedback}</div>}
              {product.protocolFeedback && <div className="protocol-feedback" role="status">{product.protocolFeedback}</div>}
            </section>

          </aside>
        </div>

        <p id="recognition-disclosure" className="sr-only">
          Starting recognition consents to transient hand and body landmark transmission; raw video is not transmitted.
        </p>
        <div className="sr-only" role="status" aria-label="Tracking announcement" aria-live="polite">
          {recognition.trackingAnnouncement}
        </div>

        {SIMULATOR_ENABLED && <RecognitionSimulator connected={connected} send={realtime.send} />}
      </section>
    );
  }

  MeetingAppConfigured.displayName = "MeetingApp";
  return MeetingAppConfigured;
}

const MeetingApp = createMeetingApp();

export default MeetingApp;
