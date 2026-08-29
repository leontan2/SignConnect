import type { ServerRealtimeEvent } from "../api";

export type ParseRealtimeEventResult =
  | { ok: true; event: ServerRealtimeEvent }
  | { ok: false; reason: "malformed" | "unsupported" };

type JsonObject = Record<string, unknown>;

const EVENT_KEYS = [
  "schemaVersion",
  "type",
  "meetingId",
  "streamId",
  "sequence",
  "payload",
  "occurredAt"
] as const;

const ROOM_CAPTION_EVENT_KEYS = [
  "schemaVersion",
  "type",
  "meetingId",
  "participantId",
  "captionId",
  "streamId",
  "sequence",
  "payload",
  "occurredAt"
] as const;

const PARTICIPANT_EVENT_KEYS = [
  "schemaVersion",
  "type",
  "meetingId",
  "participantId",
  "sequence",
  "payload",
  "occurredAt"
] as const;

const ROOM_EVENT_KEYS = [
  "schemaVersion",
  "type",
  "meetingId",
  "sequence",
  "payload",
  "occurredAt"
] as const;

const CAPTION_PAYLOAD_KEYS = [
  "labelId",
  "text",
  "confidence",
  "modelVersion",
  "inferenceLatencyMs",
  "mockModel"
] as const;

const ROOM_CAPTION_PAYLOAD_KEYS = [
  ...CAPTION_PAYLOAD_KEYS,
  "sourceDisplayName"
] as const;

const UNKNOWN_PAYLOAD_KEYS = [
  "reason",
  "confidence",
  "modelVersion",
  "inferenceLatencyMs",
  "mockModel"
] as const;

const STATUS_PAYLOAD_KEYS = [
  "state",
  "reason",
  "message",
  "modelVersion",
  "mockModel"
] as const;

const PARTICIPANT_PAYLOAD_KEYS = ["displayName", "role"] as const;
const SNAPSHOT_PAYLOAD_KEYS = ["participants"] as const;
const SNAPSHOT_PARTICIPANT_KEYS = ["participantId", "displayName", "role"] as const;
const ROOM_ERROR_PAYLOAD_KEYS = ["code", "message"] as const;

const SUPPORTED_EVENT_TYPES = new Set([
  "caption.final",
  "recognition.unknown",
  "recognition.status",
  "room.joined",
  "room.snapshot",
  "participant.joined",
  "participant.left",
  "room.error"
]);

const PARTICIPANT_ROLES = new Set(["HOST", "GUEST"]);
const ROOM_ERROR_CODES = new Set(["JOIN_REQUIRED", "INVALID_JOIN", "ALREADY_JOINED", "ROOM_FULL"]);

const UNKNOWN_REASONS = new Set([
  "LOW_CONFIDENCE",
  "UNSTABLE_PREDICTION"
]);

const STATUS_STATES = new Set([
  "READY",
  "UNAVAILABLE",
  "INVALID_INPUT",
  "STOPPED"
]);

const STATUS_REASONS = new Set([
  "STARTED",
  "RECOVERED",
  "TIMEOUT",
  "SERVICE_UNAVAILABLE",
  "INVALID_EVENT",
  "OUT_OF_ORDER",
  "UNSUPPORTED_VERSION",
  "STOPPED_BY_CLIENT"
]);

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LABEL_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MODEL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const expectedKeys = new Set(expected);
  const actualKeys = Reflect.ownKeys(value);
  return actualKeys.length === expected.length
    && actualKeys.every((key) => typeof key === "string" && expectedKeys.has(key));
}

function hasStringLength(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteInRange(value: unknown, minimum: number, maximum?: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && (maximum === undefined || value <= maximum);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPossibleLeapSecond(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number
): boolean {
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 59, 0);
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  return utc.getUTCHours() === 23
    && utc.getUTCMinutes() === 59
    && ((utc.getUTCMonth() === 5 && utc.getUTCDate() === 30)
      || (utc.getUTCMonth() === 11 && utc.getUTCDate() === 31));
}

function isRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 60
    || offsetHour > 23
    || offsetMinute > 59) {
    return false;
  }

  if (second !== 60) return true;
  const offsetSign = match[9] === "-" ? -1 : 1;
  return isPossibleLeapSecond(
    year,
    month,
    day,
    hour,
    minute,
    offsetSign * (offsetHour * 60 + offsetMinute)
  );
}

function hasValidEnvelope(event: JsonObject, type: string, nullableStreamId: boolean): boolean {
  return hasExactKeys(event, EVENT_KEYS)
    && event.schemaVersion === 1
    && event.type === type
    && isUuid(event.meetingId)
    && (nullableStreamId ? event.streamId === null || isUuid(event.streamId) : isUuid(event.streamId))
    && isNonNegativeInteger(event.sequence)
    && isRfc3339DateTime(event.occurredAt)
    && isJsonObject(event.payload);
}

function hasValidRoomEnvelope(event: JsonObject, type: string, keys: readonly string[]): boolean {
  return hasExactKeys(event, keys)
    && event.schemaVersion === 1
    && event.type === type
    && isUuid(event.meetingId)
    && isNonNegativeInteger(event.sequence)
    && isRfc3339DateTime(event.occurredAt)
    && isJsonObject(event.payload);
}

function hasValidParticipantPayload(payload: JsonObject): boolean {
  return hasExactKeys(payload, PARTICIPANT_PAYLOAD_KEYS)
    && hasStringLength(payload.displayName, 1, 50)
    && typeof payload.role === "string"
    && PARTICIPANT_ROLES.has(payload.role);
}

function isValidCaptionFinal(event: JsonObject): boolean {
  const roomCaption = hasValidRoomEnvelope(event, "caption.final", ROOM_CAPTION_EVENT_KEYS)
    && isUuid(event.participantId)
    && isUuid(event.captionId)
    && isUuid(event.streamId);
  const privateCaption = hasValidEnvelope(event, "caption.final", false);
  if (!roomCaption && !privateCaption) return false;
  const payload = event.payload as JsonObject;
  return hasExactKeys(payload, roomCaption ? ROOM_CAPTION_PAYLOAD_KEYS : CAPTION_PAYLOAD_KEYS)
    && hasStringLength(payload.labelId, 1, 64)
    && LABEL_ID_PATTERN.test(payload.labelId)
    && hasStringLength(payload.text, 1, 240)
    && isFiniteInRange(payload.confidence, 0, 1)
    && hasStringLength(payload.modelVersion, 1, 64)
    && MODEL_VERSION_PATTERN.test(payload.modelVersion)
    && isFiniteInRange(payload.inferenceLatencyMs, 0)
    && typeof payload.mockModel === "boolean"
    && (!roomCaption || hasStringLength(payload.sourceDisplayName, 1, 50));
}

function isValidRecognitionUnknown(event: JsonObject): boolean {
  if (!hasValidEnvelope(event, "recognition.unknown", false)) return false;
  const payload = event.payload as JsonObject;
  return hasExactKeys(payload, UNKNOWN_PAYLOAD_KEYS)
    && typeof payload.reason === "string"
    && UNKNOWN_REASONS.has(payload.reason)
    && isFiniteInRange(payload.confidence, 0, 1)
    && hasStringLength(payload.modelVersion, 1, 64)
    && MODEL_VERSION_PATTERN.test(payload.modelVersion)
    && isFiniteInRange(payload.inferenceLatencyMs, 0)
    && typeof payload.mockModel === "boolean";
}

function isValidRecognitionStatus(event: JsonObject): boolean {
  if (!hasValidEnvelope(event, "recognition.status", true)) return false;
  const payload = event.payload as JsonObject;
  return hasExactKeys(payload, STATUS_PAYLOAD_KEYS)
    && typeof payload.state === "string"
    && STATUS_STATES.has(payload.state)
    && typeof payload.reason === "string"
    && STATUS_REASONS.has(payload.reason)
    && hasStringLength(payload.message, 1, 160)
    && (payload.modelVersion === null
      || (hasStringLength(payload.modelVersion, 1, 64)
        && MODEL_VERSION_PATTERN.test(payload.modelVersion)))
    && (payload.mockModel === null || typeof payload.mockModel === "boolean");
}

function isValidRoomJoined(event: JsonObject): boolean {
  return hasValidRoomEnvelope(event, "room.joined", PARTICIPANT_EVENT_KEYS)
    && isUuid(event.participantId)
    && hasValidParticipantPayload(event.payload as JsonObject);
}

function isValidRoomSnapshot(event: JsonObject): boolean {
  if (!hasValidRoomEnvelope(event, "room.snapshot", ROOM_EVENT_KEYS)) return false;
  const payload = event.payload as JsonObject;
  if (!hasExactKeys(payload, SNAPSHOT_PAYLOAD_KEYS)
    || !Array.isArray(payload.participants)
    || payload.participants.length > 50) {
    return false;
  }
  return payload.participants.every((participant) => isJsonObject(participant)
    && hasExactKeys(participant, SNAPSHOT_PARTICIPANT_KEYS)
    && isUuid(participant.participantId)
    && hasStringLength(participant.displayName, 1, 50)
    && typeof participant.role === "string"
    && PARTICIPANT_ROLES.has(participant.role));
}

function isValidParticipantPresence(event: JsonObject): boolean {
  return (hasValidRoomEnvelope(event, "participant.joined", PARTICIPANT_EVENT_KEYS)
      || hasValidRoomEnvelope(event, "participant.left", PARTICIPANT_EVENT_KEYS))
    && isUuid(event.participantId)
    && hasValidParticipantPayload(event.payload as JsonObject);
}

function isValidRoomError(event: JsonObject): boolean {
  if (!hasValidRoomEnvelope(event, "room.error", ROOM_EVENT_KEYS)) return false;
  const payload = event.payload as JsonObject;
  return hasExactKeys(payload, ROOM_ERROR_PAYLOAD_KEYS)
    && typeof payload.code === "string"
    && ROOM_ERROR_CODES.has(payload.code)
    && hasStringLength(payload.message, 1, 160);
}

export function parseRealtimeEvent(input: unknown): ParseRealtimeEventResult {
  try {
    const candidate: unknown = typeof input === "string" ? JSON.parse(input) : input;
    if (!isJsonObject(candidate)) return { ok: false, reason: "malformed" };

    const hasType = hasOwn(candidate, "type");
    const hasVersion = hasOwn(candidate, "schemaVersion");
    if (hasType
      && typeof candidate.type === "string"
      && !SUPPORTED_EVENT_TYPES.has(candidate.type)) {
      return { ok: false, reason: "unsupported" };
    }
    if (hasVersion && candidate.schemaVersion !== 1) {
      return { ok: false, reason: "unsupported" };
    }
    if (!hasType || typeof candidate.type !== "string" || !hasVersion) {
      return { ok: false, reason: "malformed" };
    }

    let valid = false;
    switch (candidate.type) {
      case "caption.final":
        valid = isValidCaptionFinal(candidate);
        break;
      case "recognition.unknown":
        valid = isValidRecognitionUnknown(candidate);
        break;
      case "recognition.status":
        valid = isValidRecognitionStatus(candidate);
        break;
      case "room.joined":
        valid = isValidRoomJoined(candidate);
        break;
      case "room.snapshot":
        valid = isValidRoomSnapshot(candidate);
        break;
      case "participant.joined":
      case "participant.left":
        valid = isValidParticipantPresence(candidate);
        break;
      case "room.error":
        valid = isValidRoomError(candidate);
        break;
    }

    return valid
      ? { ok: true, event: candidate as ServerRealtimeEvent }
      : { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
