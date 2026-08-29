import type { LandmarkChunk } from "./recognition/contracts";

export type Meeting = {
  id: string;
  title: string;
  joinCode: string;
  status: "READY" | "ACTIVE" | "ENDED";
  createdAt: string;
};

export type ParticipantRole = "HOST" | "GUEST";

export type Participant = {
  id: string;
  displayName: string;
  role: ParticipantRole;
};

export type MeetingSession = {
  meeting: Meeting;
  participant: Participant;
  realtimeTicket: string;
  realtimeTicketExpiresAt: string;
};

export type RoomJoinEvent = {
  schemaVersion: 1;
  type: "room.join";
  ticket: string;
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

export type ClientRealtimeEvent =
  | LandmarkChunk
  | RecognitionControlEvent
  | LegacyRecognitionResultEvent
  | RoomJoinEvent;

type ServerEventEnvelope = {
  schemaVersion: 1;
  meetingId: string;
  sequence: number;
  occurredAt: string;
};

export type CaptionFinalEvent = ServerEventEnvelope & {
  type: "caption.final";
  captionId?: string;
  participantId?: string;
  streamId: string;
  payload: {
    labelId: string;
    text: string;
    confidence: number;
    modelVersion: string;
    inferenceLatencyMs: number;
    mockModel: boolean;
    sourceDisplayName?: string;
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

export type RoomParticipant = {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
};

export type RoomJoinedEvent = ServerEventEnvelope & {
  type: "room.joined";
  participantId: string;
  payload: {
    displayName: string;
    role: ParticipantRole;
  };
};

export type RoomSnapshotEvent = ServerEventEnvelope & {
  type: "room.snapshot";
  payload: {
    participants: RoomParticipant[];
  };
};

type ParticipantEvent = ServerEventEnvelope & {
  participantId: string;
  payload: {
    displayName: string;
    role: ParticipantRole;
  };
};

export type ParticipantPresenceEvent =
  | (ParticipantEvent & { type: "participant.joined" })
  | (ParticipantEvent & { type: "participant.left" });

export type RoomErrorCode = "JOIN_REQUIRED" | "INVALID_JOIN" | "ALREADY_JOINED" | "ROOM_FULL";

export type RoomErrorEvent = ServerEventEnvelope & {
  type: "room.error";
  payload: {
    code: RoomErrorCode;
    message: string;
  };
};

export type ServerRealtimeEvent =
  | CaptionFinalEvent
  | RecognitionUnknownEvent
  | RecognitionStatusEvent
  | RoomJoinedEvent
  | RoomSnapshotEvent
  | ParticipantPresenceEvent
  | RoomErrorEvent;
export type CaptionEvent = CaptionFinalEvent;

export class MeetingRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MeetingRequestError";
  }
}

async function readMeetingSession(response: Response): Promise<MeetingSession> {
  if (!response.ok) {
    throw new MeetingRequestError(response.status, response.status === 404
      ? "That room code is not active."
      : "Meeting service rejected the request.");
  }
  return response.json() as Promise<MeetingSession>;
}

export async function createMeeting(title: string, displayName = "Host"): Promise<MeetingSession> {
  const response = await fetch(`${process.env.MEETING_API_URL}/api/v1/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, displayName })
  });

  return readMeetingSession(response);
}

export async function joinMeeting(joinCode: string, displayName: string): Promise<MeetingSession> {
  const normalizedCode = joinCode.replace(/\s+/g, "").toUpperCase();
  const response = await fetch(
    `${process.env.MEETING_API_URL}/api/v1/meetings/${encodeURIComponent(normalizedCode)}/participants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName })
    }
  );

  return readMeetingSession(response);
}

export function realtimeEndpoint(meetingId: string): string {
  return `${process.env.REALTIME_WS_URL}/ws/v1/realtime/${meetingId}`;
}

export { parseRealtimeEvent, type ParseRealtimeEventResult } from "./recognition/parseRealtimeEvent";
export { RealtimeClient } from "./recognition/RealtimeClient";
