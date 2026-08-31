import type { CaptionFinalEvent } from "./api";

export const SIGNED_SENTENCE_PAUSE_MS = 2_500;
export const SIGNED_SENTENCE_MAX_PARTS = 12;

type SignedSentencePart = {
  captionId: string;
  text: string;
  confidence: number;
  modelVersion: string;
  mockModel: boolean;
};

export type SignedSentence = {
  id: string;
  participantId: string;
  sourceDisplayName: string;
  streamId: string;
  startedAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  status: "partial" | "final";
  text: string;
  captionIds: string[];
  confidence: number;
  modelVersions: string[];
  mockModel: boolean;
  parts: SignedSentencePart[];
};

function captionIdentity(caption: CaptionFinalEvent): string {
  return caption.captionId ?? `${caption.streamId}-${caption.sequence}`;
}

function normalizeFragment(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/u, "").trim();
}

function continuationFragment(text: string): string {
  if (/^I(?:\b|['’])/u.test(text)) return text;
  if (/^[A-Z][a-z]/u.test(text)) return `${text[0].toLocaleLowerCase()}${text.slice(1)}`;
  return text;
}

function sentenceText(parts: SignedSentencePart[], final: boolean): string {
  const fragments = parts
    .map((part) => normalizeFragment(part.text))
    .filter(Boolean)
    .map((fragment, index) => index === 0 ? fragment : continuationFragment(fragment));
  const joined = fragments.join(" ");
  if (!joined) return "";
  const text = `${joined[0].toLocaleUpperCase()}${joined.slice(1)}`;
  if (!final) return text;
  const lastSourceText = parts.at(-1)?.text.trim() ?? "";
  const punctuation = lastSourceText.endsWith("?") ? "?" : lastSourceText.endsWith("!") ? "!" : ".";
  return `${text}${punctuation}`;
}

function summarizeParts(parts: SignedSentencePart[]): Pick<
  SignedSentence,
  "text" | "captionIds" | "confidence" | "modelVersions" | "mockModel"
> {
  return {
    text: sentenceText(parts, false),
    captionIds: parts.map((part) => part.captionId),
    confidence: parts.reduce((total, part) => total + part.confidence, 0) / parts.length,
    modelVersions: [...new Set(parts.map((part) => part.modelVersion))],
    mockModel: parts.some((part) => part.mockModel)
  };
}

function finalize(sentence: SignedSentence, finalizedAt: string): SignedSentence {
  if (sentence.status === "final") return sentence;
  return {
    ...sentence,
    status: "final",
    text: sentenceText(sentence.parts, true),
    finalizedAt
  };
}

export function appendCaptionToSignedSentences(
  current: SignedSentence[],
  caption: CaptionFinalEvent
): SignedSentence[] {
  const captionId = captionIdentity(caption);
  if (current.some((sentence) => sentence.captionIds.includes(captionId))) return current;
  const participantId = caption.participantId ?? `private-${caption.streamId}`;
  const occurredAtMs = Date.parse(caption.occurredAt);
  let activeIndex = -1;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index].status !== "partial") continue;
    activeIndex = index;
    break;
  }
  const active = activeIndex >= 0 ? current[activeIndex] : null;
  const activeAtMs = active ? Date.parse(active.updatedAt) : Number.NaN;
  const canAppend = active !== null
    && active.participantId === participantId
    && active.streamId === caption.streamId
    && Number.isFinite(occurredAtMs)
    && Number.isFinite(activeAtMs)
    && occurredAtMs >= activeAtMs
    && occurredAtMs - activeAtMs <= SIGNED_SENTENCE_PAUSE_MS
    && active.parts.length < SIGNED_SENTENCE_MAX_PARTS;

  const next = current.map((sentence, index) => (
    sentence.status === "partial" && (!canAppend || index !== activeIndex)
      ? finalize(sentence, caption.occurredAt)
      : sentence
  ));
  const part: SignedSentencePart = {
    captionId,
    text: caption.payload.text,
    confidence: caption.payload.confidence,
    modelVersion: caption.payload.modelVersion,
    mockModel: caption.payload.mockModel
  };

  if (canAppend && activeIndex >= 0) {
    const parts = [...next[activeIndex].parts, part];
    next[activeIndex] = {
      ...next[activeIndex],
      ...summarizeParts(parts),
      updatedAt: caption.occurredAt,
      parts
    };
    return next;
  }

  next.push({
    id: `signed-sentence-${captionId}`,
    participantId,
    sourceDisplayName: caption.payload.sourceDisplayName ?? "Participant",
    streamId: caption.streamId,
    startedAt: caption.occurredAt,
    updatedAt: caption.occurredAt,
    finalizedAt: null,
    status: "partial",
    ...summarizeParts([part]),
    parts: [part]
  });
  return next;
}

export function finalizeSignedSentence(
  current: SignedSentence[],
  sentenceId: string,
  finalizedAtMs = Date.now()
): SignedSentence[] {
  const finalizedAt = new Date(finalizedAtMs).toISOString();
  return current.map((sentence) => sentence.id === sentenceId ? finalize(sentence, finalizedAt) : sentence);
}

export function finalizeAllSignedSentences(
  current: SignedSentence[],
  finalizedAtMs = Date.now()
): SignedSentence[] {
  const finalizedAt = new Date(finalizedAtMs).toISOString();
  return current.map((sentence) => finalize(sentence, finalizedAt));
}
