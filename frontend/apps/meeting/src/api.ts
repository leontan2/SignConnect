import type { LandmarkChunk } from "./recognition/contracts";

export type Meeting = {
  id: string;
  title: string;
  status: "READY" | "ACTIVE" | "ENDED";
  createdAt: string;
};

export type RecognitionControlEvent = {
  schemaVersion: 1;
  type: "recognition.control";
  streamId: string;
  sequence: number;
  timestampMs: number;
  action: "start" | "stop";
};

export type LegacyRecognitionResultEvent = {
  type: "recognition.result";
  sequence: number;
  payload: {
    text: string;
    confidence: number;
  };
};

export type ClientRealtimeEvent = LandmarkChunk | RecognitionControlEvent | LegacyRecognitionResultEvent;

type ServerEventEnvelope = {
  schemaVersion: 1;
  meetingId: string;
  sequence: number;
  occurredAt: string;
};

export type CaptionFinalEvent = ServerEventEnvelope & {
  type: "caption.final";
  streamId: string;
  payload: {
    labelId: string;
    text: string;
    confidence: number;
    modelVersion: string;
    inferenceLatencyMs: number;
    mockModel: boolean;
  };
};

export type RecognitionUnknownEvent = ServerEventEnvelope & {
  type: "recognition.unknown";
  streamId: string;
  payload: {
    reason: "LOW_CONFIDENCE" | "UNSTABLE_PREDICTION";
    confidence: number;
    modelVersion: string;
    inferenceLatencyMs: number;
    mockModel: boolean;
  };
};

export type RecognitionStatusState = "READY" | "UNAVAILABLE" | "INVALID_INPUT" | "STOPPED";

export type RecognitionStatusReason =
  | "STARTED"
  | "RECOVERED"
  | "TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_EVENT"
  | "OUT_OF_ORDER"
  | "UNSUPPORTED_VERSION"
  | "STOPPED_BY_CLIENT";

export type RecognitionStatusEvent = ServerEventEnvelope & {
  type: "recognition.status";
  streamId: string | null;
  payload: {
    state: RecognitionStatusState;
    reason: RecognitionStatusReason;
    message: string;
    modelVersion: string | null;
    mockModel: boolean | null;
  };
};

export type ServerRealtimeEvent = CaptionFinalEvent | RecognitionUnknownEvent | RecognitionStatusEvent;
export type CaptionEvent = CaptionFinalEvent;

export async function createMeeting(title: string): Promise<Meeting> {
  const response = await fetch(`${process.env.MEETING_API_URL}/api/v1/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });

  if (!response.ok) {
    throw new Error("Meeting service rejected the request");
  }

  return response.json() as Promise<Meeting>;
}

export function realtimeEndpoint(meetingId: string): string {
  return `${process.env.REALTIME_WS_URL}/ws/v1/realtime/${meetingId}`;
}

export { parseRealtimeEvent, type ParseRealtimeEventResult } from "./recognition/parseRealtimeEvent";
export { RealtimeClient } from "./recognition/RealtimeClient";
