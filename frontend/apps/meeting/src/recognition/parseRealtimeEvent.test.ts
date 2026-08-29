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
    expect(parseRealtimeEvent(roomCaption)).toEqual({ ok: true, event: roomCaption });
    expect(parseRealtimeEvent(roomJoined)).toEqual({ ok: true, event: roomJoined });
    expect(parseRealtimeEvent(roomSnapshot)).toEqual({ ok: true, event: roomSnapshot });
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
});
