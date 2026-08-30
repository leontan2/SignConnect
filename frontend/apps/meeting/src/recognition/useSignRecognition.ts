import { useCallback, useEffect, useRef, useState } from "react";

import type { RecognitionControlEvent } from "../api";
import type {
  BrowserLocalVisionFrame,
  LandmarkCaptureStatus,
  LandmarkChunk,
  LandmarkFrame
} from "./contracts";
import {
  FRAMES_PER_LANDMARK_CHUNK as FRAMES_PER_CHUNK,
  LANDMARK_CHUNK_TYPE,
  LANDMARK_FEATURE_COUNT as FEATURE_COUNT,
  LANDMARK_SCHEMA_VERSION as SCHEMA_VERSION
} from "./contracts";
import type { RealtimeConnectionState } from "./RealtimeClient";
import type { GestureCandidateFrame } from "./trackingQuality";
import {
  useLandmarkCapture,
  type UseLandmarkCaptureOptions
} from "./useLandmarkCapture";

export interface RecognitionClock {
  now(): number;
}

export interface UseSignRecognitionOptions {
  cameraEnabled: boolean;
  getVideo(): HTMLVideoElement | null;
  realtimeState: RealtimeConnectionState;
  send(event: RecognitionControlEvent | LandmarkChunk): boolean;
  isUnderPressure(): boolean;
  /** Landmark and control delivery remain blocked until the room grants this stream ownership. */
  signerGranted?: boolean;
  captureOptions?: Omit<UseLandmarkCaptureOptions, "onStatus" | "onGestureCandidate">;
  clock?: RecognitionClock;
  trackingAnnouncementDelayMs?: number;
  onGestureDispatched?: (streamId: string) => void;
  onStreamChange?: (streamId: string | null) => void;
  onOwnershipReleaseNeeded?: (
    streamId: string,
    reason: "recognition_stopped" | "user_request"
  ) => void;
}

export interface UseSignRecognitionResult {
  captureStatus: LandmarkCaptureStatus;
  enabledByUser: boolean;
  active: boolean;
  streamId: string | null;
  browserLocalFrame: BrowserLocalVisionFrame | null;
  trackingAnnouncement: string;
  settleGesture(streamId: string): void;
  start(): boolean;
  stop(): void;
  revoke(): void;
  cameraOff(): void;
}

const defaultClock: RecognitionClock = { now: () => performance.now() };
const COMPLETED_GESTURE_FRAME_COUNT = 30;

type GestureTransportState = {
  streamId: string;
  nextChunkSequence: number;
  nextFrameSequence: number;
  lastTimestampMs: number;
};

function candidateChunks(
  candidate: readonly GestureCandidateFrame[],
  transport: GestureTransportState
): LandmarkChunk[] {
  if (candidate.length !== COMPLETED_GESTURE_FRAME_COUNT) {
    throw new TypeError(`Completed gestures require exactly ${COMPLETED_GESTURE_FRAME_COUNT} frames.`);
  }

  let lastTimestampMs = transport.lastTimestampMs;
  const frames: LandmarkFrame[] = candidate.map((frame, index) => {
    if (frame.features.length !== FEATURE_COUNT || !frame.features.every(Number.isFinite)) {
      throw new TypeError(`Gesture frames require exactly ${FEATURE_COUNT} finite features.`);
    }
    if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs <= lastTimestampMs) {
      throw new RangeError("Gesture frame timestamps must be finite, non-negative, and strictly increasing.");
    }
    lastTimestampMs = frame.timestampMs;
    return {
      sequence: transport.nextFrameSequence + index,
      timestampMs: frame.timestampMs,
      features: [...frame.features]
    };
  });

  const chunks: LandmarkChunk[] = [];
  for (let offset = 0; offset < frames.length; offset += FRAMES_PER_CHUNK) {
    chunks.push({
      schemaVersion: SCHEMA_VERSION,
      type: LANDMARK_CHUNK_TYPE,
      streamId: transport.streamId,
      sequence: transport.nextChunkSequence + chunks.length,
      frames: frames.slice(offset, offset + FRAMES_PER_CHUNK)
    });
  }
  return chunks;
}

export function captureStatusText(status: LandmarkCaptureStatus): string {
  switch (status) {
    case "model-loading":
      return "MediaPipe model is loading.";
    case "camera-waiting":
      return "Waiting for camera frames.";
    case "ready":
      return "Tracking is ready.";
    case "tracking":
      return "Hands are being tracked.";
    case "no-hands":
      return "No hands detected. Recognition is idle.";
    case "low-quality":
      return "Tracking quality is low. Move into view and improve lighting.";
    case "unavailable":
      return "MediaPipe model is unavailable.";
    case "error":
      return "Landmark tracking stopped after an unexpected error.";
    default:
      return "Recognition stopped.";
  }
}

function isAnnouncedTrackingStatus(status: LandmarkCaptureStatus): boolean {
  return status === "tracking" || status === "no-hands" || status === "low-quality";
}

export function useSignRecognition(options: UseSignRecognitionOptions): UseSignRecognitionResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clock = options.clock ?? defaultClock;
  const enabledRef = useRef(false);
  const activeStreamRef = useRef<string | null>(null);
  const serverStartedStreamRef = useRef<string | null>(null);
  const gestureTransportRef = useRef<GestureTransportState | null>(null);
  const gestureInFlightStreamRef = useRef<string | null>(null);
  const failGestureTransportRef = useRef<() => void>(() => undefined);
  const lastControlTimestampRef = useRef(Number.NEGATIVE_INFINITY);
  const [enabledByUser, setEnabledByUser] = useState(false);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [trackingAnnouncement, setTrackingAnnouncement] = useState("");

  const capture = useLandmarkCapture({
    ...options.captureOptions,
    onGestureCandidate: (candidate) => {
      const streamId = activeStreamRef.current;
      const transport = gestureTransportRef.current;
      if (!enabledRef.current
        || !streamId
        || serverStartedStreamRef.current !== streamId
        || transport?.streamId !== streamId
        || gestureInFlightStreamRef.current === streamId
        || optionsRef.current.signerGranted === false) {
        return;
      }

      if (optionsRef.current.isUnderPressure()) {
        failGestureTransportRef.current();
        return;
      }

      let chunks: LandmarkChunk[];
      try {
        chunks = candidateChunks(candidate, transport);
      } catch {
        failGestureTransportRef.current();
        return;
      }

      // v1 terminal events identify only the stream, not an individual gesture.
      // Keep exactly one completed gesture in flight so a result cannot be
      // attributed to a newer gesture on the same stream.
      gestureInFlightStreamRef.current = streamId;
      for (const chunk of chunks) {
        if (optionsRef.current.isUnderPressure() || !optionsRef.current.send(chunk)) {
          failGestureTransportRef.current();
          return;
        }
        transport.nextChunkSequence += 1;
        transport.nextFrameSequence += chunk.frames.length;
        transport.lastTimestampMs = chunk.frames.at(-1)!.timestampMs;
      }
      optionsRef.current.onGestureDispatched?.(streamId);
    }
  });
  const captureStatus = capture.status;
  const startCapture = capture.start;
  const stopCapture = capture.stop;
  const cameraOffCapture = capture.cameraOff;
  const resumeCapture = capture.resumeCapture;

  const setActiveStream = useCallback((streamId: string | null) => {
    activeStreamRef.current = streamId;
    if (streamId === null) {
      serverStartedStreamRef.current = null;
      gestureTransportRef.current = null;
      gestureInFlightStreamRef.current = null;
    }
    setActiveStreamId(streamId);
    optionsRef.current.onStreamChange?.(streamId);
  }, []);

  const settleGesture = useCallback((streamId: string) => {
    if (gestureInFlightStreamRef.current === streamId) {
      gestureInFlightStreamRef.current = null;
    }
  }, []);

  const timestamp = useCallback(() => {
    const sampled = clock.now();
    const finite = Number.isFinite(sampled) && sampled >= 0 ? sampled : 0;
    const next = Math.max(finite, lastControlTimestampRef.current + 0.001);
    lastControlTimestampRef.current = next;
    return next;
  }, [clock]);

  const beginStream = useCallback(() => {
    const video = optionsRef.current.getVideo();
    if (!enabledRef.current
      || !optionsRef.current.cameraEnabled
      || optionsRef.current.realtimeState.status !== "connected"
      || !video) {
      return false;
    }

    const streamId = startCapture(video, true);
    if (!streamId) return false;
    lastControlTimestampRef.current = Number.NEGATIVE_INFINITY;
    setActiveStream(streamId);
    return true;
  }, [setActiveStream, startCapture]);

  const start = useCallback(() => {
    if (enabledRef.current
      || !optionsRef.current.cameraEnabled
      || optionsRef.current.realtimeState.status !== "connected") {
      return false;
    }
    enabledRef.current = true;
    setEnabledByUser(true);
    if (beginStream()) return true;
    enabledRef.current = false;
    setEnabledByUser(false);
    return false;
  }, [beginStream]);

  const stopStream = useCallback((
    preserveIntent: boolean,
    notifyServer: boolean,
    releaseReason?: "recognition_stopped" | "user_request"
  ) => {
    const streamId = activeStreamRef.current;
    const serverStarted = streamId !== null && serverStartedStreamRef.current === streamId;
    if (!preserveIntent) {
      enabledRef.current = false;
      setEnabledByUser(false);
    }
    if (streamId && serverStarted && notifyServer) {
      optionsRef.current.send({
        schemaVersion: 1,
        type: "recognition.control",
        streamId,
        sequence: 1,
        timestampMs: timestamp(),
        action: "stop"
      });
    } else if (streamId && !serverStarted && releaseReason) {
      optionsRef.current.onOwnershipReleaseNeeded?.(streamId, releaseReason);
    }
    setActiveStream(null);
    stopCapture();
  }, [setActiveStream, stopCapture, timestamp]);
  failGestureTransportRef.current = () => stopStream(false, true, "recognition_stopped");

  const stop = useCallback(() => stopStream(false, true, "recognition_stopped"), [stopStream]);
  const revoke = useCallback(() => stopStream(false, false), [stopStream]);
  const cameraOff = useCallback(() => {
    const streamId = activeStreamRef.current;
    const serverStarted = streamId !== null && serverStartedStreamRef.current === streamId;
    enabledRef.current = false;
    setEnabledByUser(false);
    if (streamId && serverStarted) {
      optionsRef.current.send({
        schemaVersion: 1,
        type: "recognition.control",
        streamId,
        sequence: 1,
        timestampMs: timestamp(),
        action: "stop"
      });
    } else if (streamId) {
      optionsRef.current.onOwnershipReleaseNeeded?.(streamId, "user_request");
    }
    setActiveStream(null);
    cameraOffCapture();
  }, [cameraOffCapture, setActiveStream, timestamp]);

  useEffect(() => {
    const captureReady = captureStatus === "ready"
      || captureStatus === "tracking"
      || captureStatus === "no-hands"
      || captureStatus === "low-quality";
    const streamId = activeStreamRef.current;
    if (!captureReady
      || !enabledRef.current
      || !streamId
      || serverStartedStreamRef.current === streamId
      || options.signerGranted === false
      || !options.cameraEnabled
      || options.realtimeState.status !== "connected") {
      return;
    }

    const control: RecognitionControlEvent = {
      schemaVersion: 1,
      type: "recognition.control",
      streamId,
      sequence: 0,
      timestampMs: timestamp(),
      action: "start"
    };
    if (optionsRef.current.send(control)) {
      serverStartedStreamRef.current = streamId;
      gestureTransportRef.current = {
        streamId,
        nextChunkSequence: 0,
        nextFrameSequence: 0,
        lastTimestampMs: control.timestampMs
      };
      resumeCapture();
    } else {
      optionsRef.current.onOwnershipReleaseNeeded?.(streamId, "recognition_stopped");
      stopStream(false, false);
    }
  }, [captureStatus, options.cameraEnabled, options.realtimeState.status, options.signerGranted, resumeCapture, stopStream, timestamp]);

  useEffect(() => {
    if (options.realtimeState.status === "reconnecting" && activeStreamRef.current) {
      stopStream(true, false);
      return;
    }
    if (options.realtimeState.status === "connected"
      && enabledRef.current
      && !activeStreamRef.current
      && options.cameraEnabled) {
      beginStream();
    }
  }, [beginStream, options.cameraEnabled, options.realtimeState.generation, options.realtimeState.status, stopStream]);

  useEffect(() => {
    if (!options.cameraEnabled && (enabledRef.current || activeStreamRef.current)) {
      cameraOff();
    }
  }, [cameraOff, options.cameraEnabled]);

  useEffect(() => {
    if ((captureStatus === "unavailable" || captureStatus === "error")
      && activeStreamRef.current) {
      stopStream(false, true, "recognition_stopped");
    }
  }, [captureStatus, stopStream]);

  useEffect(() => {
    if (!isAnnouncedTrackingStatus(captureStatus)) {
      setTrackingAnnouncement("");
      return;
    }
    const delay = options.trackingAnnouncementDelayMs ?? 500;
    const handle = window.setTimeout(() => {
      setTrackingAnnouncement(captureStatusText(captureStatus));
    }, delay);
    return () => window.clearTimeout(handle);
  }, [captureStatus, options.trackingAnnouncementDelayMs]);

  useEffect(() => () => {
    enabledRef.current = false;
    const streamId = activeStreamRef.current;
    if (streamId && serverStartedStreamRef.current === streamId) {
      optionsRef.current.send({
        schemaVersion: 1,
        type: "recognition.control",
        streamId,
        sequence: 1,
        timestampMs: timestamp(),
        action: "stop"
      });
    }
    activeStreamRef.current = null;
    serverStartedStreamRef.current = null;
    gestureTransportRef.current = null;
    gestureInFlightStreamRef.current = null;
    stopCapture();
  }, [stopCapture, timestamp]);

  return {
    captureStatus,
    enabledByUser,
    active: activeStreamId !== null,
    streamId: activeStreamId,
    browserLocalFrame: capture.browserLocalFrame,
    trackingAnnouncement,
    settleGesture,
    start,
    stop,
    revoke,
    cameraOff
  };
}
