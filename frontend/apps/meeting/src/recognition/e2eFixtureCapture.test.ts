import { afterEach, describe, expect, it, vi } from "vitest";

const STREAM_ID = "11111111-1111-4111-8111-111111111111";

async function replayGateConstructor() {
  vi.stubEnv("RECOGNITION_E2E_FIXTURE_ENABLED", "true");
  vi.resetModules();
  return (await import("./e2eFixtureCapture")).E2eFixtureReplayGate;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("E2eFixtureReplayGate", () => {
  it("preserves the complete finite replay until the matching recognition start is sent", async () => {
    const E2eFixtureReplayGate = await replayGateConstructor();
    const gate = new E2eFixtureReplayGate(50);

    gate.observeSuccessfullySent(JSON.stringify({
      schemaVersion: 1,
      type: "signer.request",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      streamId: STREAM_ID,
      sequence: 0,
      timestampMs: 0
    }));

    expect(Array.from({ length: 15 }, () => gate.nextSourceIndex()))
      .toEqual(Array.from({ length: 15 }, () => 0));
    expect(gate.observeSuccessfullySent(JSON.stringify({
      schemaVersion: 1,
      type: "recognition.control",
      streamId: "22222222-2222-4222-8222-222222222222",
      sequence: 0,
      timestampMs: 600,
      action: "start"
    }))).toBe(false);
    expect(gate.nextSourceIndex()).toBe(0);

    expect(gate.observeSuccessfullySent(JSON.stringify({
      schemaVersion: 1,
      type: "recognition.control",
      streamId: STREAM_ID,
      sequence: 0,
      timestampMs: 640,
      action: "start"
    }))).toBe(true);
    expect(Array.from({ length: 50 }, () => gate.nextSourceIndex()))
      .toEqual(Array.from({ length: 50 }, (_, index) => index));
    expect([gate.nextSourceIndex(), gate.nextSourceIndex()]).toEqual([0, 0]);
  });

  it("ignores malformed and duplicate start signals without restarting an active replay", async () => {
    const E2eFixtureReplayGate = await replayGateConstructor();
    const gate = new E2eFixtureReplayGate(3);

    expect(gate.observeSuccessfullySent("not-json")).toBe(false);
    gate.observeSuccessfullySent(JSON.stringify({ type: "signer.request", streamId: STREAM_ID }));
    expect(gate.observeSuccessfullySent(JSON.stringify({
      type: "recognition.control",
      action: "start",
      streamId: STREAM_ID
    }))).toBe(true);
    expect(gate.nextSourceIndex()).toBe(0);
    expect(gate.observeSuccessfullySent(JSON.stringify({
      type: "recognition.control",
      action: "start",
      streamId: STREAM_ID
    }))).toBe(false);
    expect(gate.nextSourceIndex()).toBe(1);
  });

});
