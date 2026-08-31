import { describe, expect, it } from "vitest";

import type { CaptionFinalEvent } from "./api";
import {
  SIGNED_SENTENCE_MAX_PARTS,
  SIGNED_SENTENCE_PAUSE_MS,
  appendCaptionToSignedSentences,
  finalizeSignedSentence
} from "./signedSentence";

function caption(
  sequence: number,
  text: string,
  occurredAtMs: number,
  participantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  streamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
): CaptionFinalEvent {
  return {
    schemaVersion: 1,
    type: "caption.final",
    meetingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    participantId,
    captionId: `caption-${sequence}`,
    streamId,
    sequence,
    occurredAt: new Date(occurredAtMs).toISOString(),
    payload: {
      labelId: `label-${sequence}`,
      text,
      confidence: 0.9,
      modelVersion: "sentence-test-v1",
      inferenceLatencyMs: 30,
      mockModel: false,
      sourceDisplayName: participantId.startsWith("a") ? "Aisha" : "Ben"
    }
  };
}

describe("signed sentence composition", () => {
  it("turns ordered sign captions into one deduplicated provisional sentence and finalizes it", () => {
    let sentences = appendCaptionToSignedSentences([], caption(1, "I", 1_000));
    sentences = appendCaptionToSignedSentences(sentences, caption(2, "Need", 1_700));
    sentences = appendCaptionToSignedSentences(sentences, caption(3, "Help.", 2_400));
    sentences = appendCaptionToSignedSentences(sentences, caption(3, "Help.", 2_400));

    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({
      status: "partial",
      text: "I need help",
      captionIds: ["caption-1", "caption-2", "caption-3"],
      confidence: 0.9
    });

    const finalized = finalizeSignedSentence(sentences, sentences[0].id, 4_900);
    expect(finalized[0]).toMatchObject({
      status: "final",
      text: "I need help.",
      finalizedAt: new Date(4_900).toISOString()
    });
  });

  it("starts a new sentence after a signing pause or source change", () => {
    let sentences = appendCaptionToSignedSentences([], caption(1, "Hello", 1_000));
    sentences = appendCaptionToSignedSentences(
      sentences,
      caption(2, "Thank you", 1_000 + SIGNED_SENTENCE_PAUSE_MS + 1)
    );
    sentences = appendCaptionToSignedSentences(
      sentences,
      caption(3, "Yes", 6_000, "dddddddd-dddd-4ddd-8ddd-dddddddddddd")
    );

    expect(sentences.map((sentence) => [sentence.status, sentence.text])).toEqual([
      ["final", "Hello."],
      ["final", "Thank you."],
      ["partial", "Yes"]
    ]);
  });

  it("bounds a sentence and carries model provenance across every recognized part", () => {
    let sentences = [] as ReturnType<typeof appendCaptionToSignedSentences>;
    for (let sequence = 1; sequence <= SIGNED_SENTENCE_MAX_PARTS + 1; sequence += 1) {
      const next = caption(sequence, `Word${sequence}`, 1_000 + sequence * 100);
      next.payload.confidence = sequence === 2 ? 0.7 : 0.9;
      next.payload.mockModel = sequence === 3;
      sentences = appendCaptionToSignedSentences(sentences, next);
    }

    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ status: "final", mockModel: true });
    expect(sentences[0].captionIds).toHaveLength(SIGNED_SENTENCE_MAX_PARTS);
    expect(sentences[0].confidence).toBeCloseTo((0.7 + 0.9 * (SIGNED_SENTENCE_MAX_PARTS - 1)) / SIGNED_SENTENCE_MAX_PARTS);
    expect(sentences[1]).toMatchObject({ status: "partial", text: `Word${SIGNED_SENTENCE_MAX_PARTS + 1}` });
  });
});
