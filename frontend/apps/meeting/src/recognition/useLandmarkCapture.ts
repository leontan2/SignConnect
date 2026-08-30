import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BrowserLocalVisionFrame,
  LandmarkCaptureStatus,
  LandmarkChunkConsumer
} from "./contracts";
import {
  LandmarkCaptureController,
  type LandmarkCaptureControllerOptions
} from "./LandmarkCaptureController";

export interface UseLandmarkCaptureOptions extends Omit<
  LandmarkCaptureControllerOptions,
  "consumer" | "onStatus" | "onBrowserLocalFrame"
> {
  consumer: LandmarkChunkConsumer;
  onStatus?: (status: LandmarkCaptureStatus) => void;
  onBrowserLocalFrame?: (frame: BrowserLocalVisionFrame | null) => void;
}

export interface UseLandmarkCaptureResult {
  status: LandmarkCaptureStatus;
  streamId: string | null;
  browserLocalFrame: BrowserLocalVisionFrame | null;
  start(video: HTMLVideoElement, capturePaused?: boolean): string | null;
  stop(): void;
  restart(video: HTMLVideoElement): string | null;
  cameraOff(): void;
  resumeCapture(): void;
  drainPendingChunk(): boolean;
  getDroppedChunkCount(): number;
}

export function useLandmarkCapture(options: UseLandmarkCaptureOptions): UseLandmarkCaptureResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [status, setStatus] = useState<LandmarkCaptureStatus>("stopped");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [browserLocalFrame, setBrowserLocalFrame] = useState<BrowserLocalVisionFrame | null>(null);
  const controllerRef = useRef<LandmarkCaptureController | null>(null);

  if (!controllerRef.current) {
    const consumer: LandmarkChunkConsumer = {
      isUnderPressure: () => optionsRef.current.consumer.isUnderPressure(),
      send: (chunk) => optionsRef.current.consumer.send(chunk)
    };
    controllerRef.current = new LandmarkCaptureController({
      ...options,
      consumer,
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "stopped" || nextStatus === "unavailable" || nextStatus === "error") {
          setStreamId(null);
        }
        optionsRef.current.onStatus?.(nextStatus);
      },
      onBrowserLocalFrame: (frame) => {
        setBrowserLocalFrame(frame);
        optionsRef.current.onBrowserLocalFrame?.(frame);
      }
    });
  }

  useEffect(() => {
    const controller = controllerRef.current;
    return () => controller?.dispose();
  }, []);

  const start = useCallback((video: HTMLVideoElement, capturePaused = false) => {
    const nextStreamId = controllerRef.current!.start(video, capturePaused);
    setStreamId(nextStreamId);
    return nextStreamId;
  }, []);

  const stop = useCallback(() => {
    controllerRef.current!.stop();
    setStreamId(null);
  }, []);

  const restart = useCallback((video: HTMLVideoElement) => {
    const nextStreamId = controllerRef.current!.restart(video);
    setStreamId(nextStreamId);
    return nextStreamId;
  }, []);

  const cameraOff = useCallback(() => {
    controllerRef.current!.cameraOff();
    setStreamId(null);
  }, []);

  const resumeCapture = useCallback(() => {
    controllerRef.current!.resumeCapture();
  }, []);

  const drainPendingChunk = useCallback(() => controllerRef.current!.drainPendingChunk(), []);
  const getDroppedChunkCount = useCallback(() => controllerRef.current!.stats.droppedChunks, []);

  return {
    status,
    streamId,
    browserLocalFrame,
    start,
    stop,
    restart,
    cameraOff,
    resumeCapture,
    drainPendingChunk,
    getDroppedChunkCount
  };
}
