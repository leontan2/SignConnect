import { describe, expect, it } from "vitest";

import captionFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import malformedCaptionFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final-malformed-metadata.invalid.json";
import readyFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-recognition-status-ready.valid.json";
import unknownFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-recognition-unknown.valid.json";
import * as meetingApi from "../api";

type ParseResult =
  | { ok: true; event: { type: string } }
  | { ok: false; reason: "malformed" | "unsupported" };

type ParseRealtimeEvent = (input: unknown) => ParseResult;

describe("parseRealtimeEvent", () => {
  it("accepts the strict v1 server union and distinguishes malformed from unsupported input", () => {
    const parseRealtimeEvent = (meetingApi as unknown as {
      parseRealtimeEvent?: ParseRealtimeEvent;
    }).parseRealtimeEvent;

    expect(parseRealtimeEvent).toBeTypeOf("function");
    if (!parseRealtimeEvent) return;

    expect(parseRealtimeEvent(JSON.stringify(captionFixture))).toEqual({
      ok: true,
      event: captionFixture
    });
    expect(parseRealtimeEvent(unknownFixture)).toEqual({ ok: true, event: unknownFixture });
    expect(parseRealtimeEvent(readyFixture)).toEqual({ ok: true, event: readyFixture });
    const roomCaption = {
      ...captionFixture,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      captionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      payload: { ...captionFixture.payload, sourceDisplayName: "Leon" }
    };
    const roomJoined = {
      schemaVersion: 1,
      type: "room.joined",
      meetingId: captionFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 0,
      payload: { displayName: "Leon", role: "HOST" },
      occurredAt: captionFixture.occurredAt
    };
    const roomSnapshot = {
      schemaVersion: 1,
      type: "room.snapshot",
      meetingId: captionFixture.meetingId,
      sequence: 1,
      payload: {
        participants: [{
          participantId: roomJoined.participantId,
          displayName: "Leon",
          role: "HOST"
        }]
      },
      occurredAt: captionFixture.occurredAt
    };
    const chatMessage = {
      schemaVersion: 1,
      type: "chat.message",
      meetingId: captionFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sequence: 2,
      payload: {
        text: "Can you repeat that sign?",
        sourceDisplayName: "Leon"
      },
      occurredAt: captionFixture.occurredAt
    };
    expect(parseRealtimeEvent(roomCaption)).toEqual({ ok: true, event: roomCaption });
    expect(parseRealtimeEvent(roomJoined)).toEqual({ ok: true, event: roomJoined });
    expect(parseRealtimeEvent(roomSnapshot)).toEqual({ ok: true, event: roomSnapshot });
    expect(parseRealtimeEvent(chatMessage)).toEqual({ ok: true, event: chatMessage });
    expect(parseRealtimeEvent({
      ...chatMessage,
      payload: { ...chatMessage.payload, text: "" }
    })).toEqual({ ok: false, reason: "malformed" });
    expect(parseRealtimeEvent(JSON.stringify(malformedCaptionFixture))).toEqual({
      ok: false,
      reason: "malformed"
    });
    expect(parseRealtimeEvent("{not-json")).toEqual({ ok: false, reason: "malformed" });
    expect(parseRealtimeEvent({
      ...readyFixture,
      type: "caption.partial"
    })).toEqual({ ok: false, reason: "unsupported" });
    expect(parseRealtimeEvent({
      ...readyFixture,
      schemaVersion: 2
    })).toEqual({ ok: false, reason: "unsupported" });
    expect(parseRealtimeEvent({
      ...roomSnapshot,
      payload: {
        participants: [{ ...roomSnapshot.payload.participants[0], rawLandmarks: [1, 2, 3] }]
      }
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts signer ownership and participant update events while rejecting mismatched shapes", () => {
    const parseRealtimeEvent = (meetingApi as unknown as {
      parseRealtimeEvent?: ParseRealtimeEvent;
    }).parseRealtimeEvent;

    expect(parseRealtimeEvent).toBeTypeOf("function");
    if (!parseRealtimeEvent) return;

    const base = {
      schemaVersion: 1,
      meetingId: captionFixture.meetingId,
      sequence: 4,
      occurredAt: captionFixture.occurredAt
    } as const;
    const participantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const streamId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const granted = {
      ...base,
      type: "signer.granted",
      participantId,
      payload: { requestId, streamId }
    };
    const denied = {
      ...base,
      type: "signer.denied",
      streamId,
      payload: { requestId, reason: "SIGNER_UNAVAILABLE" }
    };
    const released = {
      ...base,
      type: "signer.released",
      participantId,
      payload: { requestId, streamId, reason: "recognition_stopped" }
    };
    const participantUpdated = {
      ...base,
      type: "participant.updated",
      participantId,
      payload: { displayName: "Leon", role: "HOST", activeSigner: true }
    };

    expect(parseRealtimeEvent(granted)).toEqual({ ok: true, event: granted });
    expect(parseRealtimeEvent(denied)).toEqual({ ok: true, event: denied });
    expect(parseRealtimeEvent(released)).toEqual({ ok: true, event: released });
    expect(parseRealtimeEvent({
      ...released,
      payload: { ...released.payload, reason: "disconnected" }
    })).toEqual({
      ok: true,
      event: { ...released, payload: { ...released.payload, reason: "disconnected" } }
    });
    expect(parseRealtimeEvent(participantUpdated)).toEqual({ ok: true, event: participantUpdated });
    expect(parseRealtimeEvent({
      ...denied,
      payload: { ...denied.payload, reason: "SOME_NEW_REASON" }
    })).toEqual({ ok: false, reason: "malformed" });
    expect(parseRealtimeEvent({
      ...released,
      payload: { ...released.payload, reason: "SOME_NEW_REASON" }
    })).toEqual({ ok: false, reason: "malformed" });
    expect(parseRealtimeEvent({
      ...participantUpdated,
      payload: { displayName: "Leon", role: "HOST" }
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts targeted call signaling while rejecting malformed media payloads", () => {
    const parseRealtimeEvent = (meetingApi as unknown as {
      parseRealtimeEvent?: ParseRealtimeEvent;
    }).parseRealtimeEvent;
    expect(parseRealtimeEvent).toBeTypeOf("function");
    if (!parseRealtimeEvent) return;

    const offer = {
      schemaVersion: 1,
      type: "call.offer",
      meetingId: captionFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetParticipantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      signalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      callId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sequence: 5,
      payload: { sdp: "v=0\r\n" },
      occurredAt: captionFixture.occurredAt
    };
    const mediaState = {
      ...offer,
      type: "media.state",
      signalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      payload: { audioEnabled: true, videoEnabled: false }
    };

    expect(parseRealtimeEvent(offer)).toEqual({ ok: true, event: offer });
    expect(parseRealtimeEvent(mediaState)).toEqual({ ok: true, event: mediaState });
    expect(parseRealtimeEvent({
      ...mediaState,
      payload: { audioEnabled: "yes", videoEnabled: false }
    })).toEqual({ ok: false, reason: "malformed" });
  });
});
