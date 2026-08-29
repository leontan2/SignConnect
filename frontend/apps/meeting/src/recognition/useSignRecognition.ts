import { useCallback, useEffect, useRef, useState } from "react";

import type { RecognitionControlEvent } from "../api";
import type {
  BrowserLocalVisionFrame,
  LandmarkCaptureStatus,
  LandmarkChunk
} from "./contracts";
import type { RealtimeConnectionState } from "./RealtimeClient";
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
  captureOptions?: Omit<UseLandmarkCaptureOptions, "consumer" | "onStatus">;
  clock?: RecognitionClock;
  trackingAnnouncementDelayMs?: number;
  onStreamChange?: (streamId: string | null) => void;
}

export interface UseSignRecognitionResult {
  captureStatus: LandmarkCaptureStatus;
  enabledByUser: boolean;
  active: boolean;
  streamId: string | null;
  browserLocalFrame: BrowserLocalVisionFrame | null;
  trackingAnnouncement: string;
  start(): boolean;
  stop(): void;
  cameraOff(): void;
}

const defaultClock: RecognitionClock = { now: () => performance.now() };

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
  const lastControlTimestampRef = useRef(Number.NEGATIVE_INFINITY);
  const [enabledByUser, setEnabledByUser] = useState(false);
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null);
  const [trackingAnnouncement, setTrackingAnnouncement] = useState("");

  const capture = useLandmarkCapture({
    ...options.captureOptions,
    consumer: {
      isUnderPressure: () => !enabledRef.current
        || activeStreamRef.current === null
        || serverStartedStreamRef.current !== activeStreamRef.current
        || optionsRef.current.isUnderPressure(),
      send: (chunk) => {
        if (!enabledRef.current
          || chunk.streamId !== activeStreamRef.current
          || chunk.streamId !== serverStartedStreamRef.current) return;
        optionsRef.current.send(chunk);
      }
    }
  });
  const captureStatus = capture.status;
  const startCapture = capture.start;
  const stopCapture = capture.stop;
  const cameraOffCapture = capture.cameraOff;

  const setActiveStream = useCallback((streamId: string | null) => {
    activeStreamRef.current = streamId;
    if (streamId === null) serverStartedStreamRef.current = null;
    setActiveStreamId(streamId);
    optionsRef.current.onStreamChange?.(streamId);
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

    const streamId = startCapture(video);
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

  const stopStream = useCallback((preserveIntent: boolean, notifyServer: boolean) => {
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
    }
    setActiveStream(null);
    stopCapture();
  }, [setActiveStream, stopCapture, timestamp]);

  const stop = useCallback(() => stopStream(false, true), [stopStream]);
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
    } else {
      stopStream(false, false);
    }
  }, [captureStatus, options.cameraEnabled, options.realtimeState.status, stopStream, timestamp]);

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
      stopStream(false, true);
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
    stopCapture();
  }, [stopCapture, timestamp]);

  return {
    captureStatus,
    enabledByUser,
    active: activeStreamId !== null,
    streamId: activeStreamId,
    browserLocalFrame: capture.browserLocalFrame,
    trackingAnnouncement,
    start,
    stop,
    cameraOff
  };
}
