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
  });
});
