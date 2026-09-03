import { describe, expect, it } from "vitest";

import partialFixture from "../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-partial.valid.json";
import revisedFixture from "../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-revised.valid.json";
import finalFixture from "../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-final.valid.json";
import cancelledFixture from "../../../../contracts/continuous-transcript/v1/fixtures/server-transcript-cancelled.valid.json";
import {
  applyTranscriptEvent,
  EMPTY_CONTINUOUS_TRANSCRIPT,
  type TranscriptCancelledEvent,
  type TranscriptTextEvent
} from "./continuousTranscript";

const partial = partialFixture as TranscriptTextEvent;
const revised = revisedFixture as TranscriptTextEvent;
const final = finalFixture as TranscriptTextEvent;
const cancelled = cancelledFixture as TranscriptCancelledEvent;

describe("continuous transcript revision lifecycle", () => {
  it("applies a partial, coalesced higher revision, and final exactly once", () => {
    const started = applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, partial);
    expect(started.outcome).toBe("applied");
    expect(started.state.active[partial.contributionId]).toMatchObject({
      phase: "provisional",
      revision: 0,
      text: "Could you"
    });

    const updated = applyTranscriptEvent(started.state, revised);
    expect(updated.outcome).toBe("applied");
    expect(updated.state.active[partial.contributionId]).toMatchObject({
      revision: 2,
      text: "Could you repeat that?"
    });

    const completed = applyTranscriptEvent(updated.state, final);
    expect(completed.outcome).toBe("applied");
    expect(completed.state.active).not.toHaveProperty(partial.contributionId);
    expect(completed.state.finalized).toHaveLength(1);
    expect(completed.state.finalized[0]).toMatchObject({ phase: "final", revision: 3 });

    const replay = applyTranscriptEvent(completed.state, final);
    expect(replay.outcome).toBe("duplicate");
    expect(replay.state).toBe(completed.state);
  });

  it("rejects stale, conflicting, identity-mismatched, and post-terminal revisions", () => {
    const started = applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, partial);
    const updated = applyTranscriptEvent(started.state, revised);

    expect(applyTranscriptEvent(updated.state, partial).outcome).toBe("stale");
    expect(applyTranscriptEvent(updated.state, {
      ...revised,
      payload: { ...revised.payload, text: "Conflicting text" }
    }).outcome).toBe("conflict");
    expect(applyTranscriptEvent(updated.state, {
      ...final,
      participantId: "99999999-9999-4999-8999-999999999999"
    }).outcome).toBe("conflict");

    const completed = applyTranscriptEvent(updated.state, final);
    expect(applyTranscriptEvent(completed.state, {
      ...final,
      type: "transcript.revised",
      revision: 4,
      sequence: 16
    }).outcome).toBe("terminal");
  });

  it("allows direct finalization but does not let revised or cancelled events create content", () => {
    const directFinal = applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, {
      ...final,
      revision: 0,
      sequence: 12
    });
    expect(directFinal.outcome).toBe("applied");
    expect(directFinal.state.finalized).toHaveLength(1);

    expect(applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, revised).outcome)
      .toBe("invalid_transition");
    expect(applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, cancelled).outcome)
      .toBe("invalid_transition");
  });

  it("cancels provisional text without adding it to finalized history", () => {
    const started = applyTranscriptEvent(EMPTY_CONTINUOUS_TRANSCRIPT, partial);
    const stopped = applyTranscriptEvent(started.state, cancelled);

    expect(stopped.outcome).toBe("applied");
    expect(stopped.state.active).not.toHaveProperty(partial.contributionId);
    expect(stopped.state.finalized).toEqual([]);
    expect(applyTranscriptEvent(stopped.state, final).outcome).toBe("terminal");
  });
});
