export type TranscriptTextEventType =
  | "transcript.partial"
  | "transcript.revised"
  | "transcript.final";

type TranscriptEnvelope = {
  schemaVersion: 1;
  transcriptVersion: 1;
  meetingId: string;
  streamId: string;
  contributionId: string;
  revision: number;
  sequence: number;
  occurredAt: string;
};

export type TranscriptTextEvent = TranscriptEnvelope & {
  type: TranscriptTextEventType;
  participantId: string;
  payload: {
    text: string;
    confidence: number;
    modelVersion: string;
    representation: "direct_text" | "gloss_to_text";
    representationVersion: string;
    sourceDisplayName: string;
  };
};

export type TranscriptCancelledEvent = TranscriptEnvelope & {
  type: "transcript.cancelled";
  participantId: string;
  payload: {
    reason:
      | "UNCERTAIN"
      | "OUT_OF_DOMAIN"
      | "CAPTURE_INVALID"
      | "MODEL_UNAVAILABLE"
      | "SIGNER_STOPPED"
      | "SUPERSEDED";
    sourceDisplayName: string;
  };
};

export type PublicTranscriptEvent = TranscriptTextEvent | TranscriptCancelledEvent;

export type TranscriptContribution = {
  contributionId: string;
  meetingId: string;
  participantId: string;
  streamId: string;
  revision: number;
  sequence: number;
  phase: "provisional" | "final";
  text: string;
  confidence: number;
  modelVersion: string;
  representation: "direct_text" | "gloss_to_text";
  representationVersion: string;
  sourceDisplayName: string;
  occurredAt: string;
};

type AcceptedRevision = {
  event: PublicTranscriptEvent;
  terminal: boolean;
};

export type ContinuousTranscriptState = {
  active: Readonly<Record<string, TranscriptContribution>>;
  finalized: readonly TranscriptContribution[];
  accepted: Readonly<Record<string, AcceptedRevision>>;
};

export type TranscriptApplyOutcome =
  | "applied"
  | "duplicate"
  | "stale"
  | "conflict"
  | "terminal"
  | "invalid_transition";

export type TranscriptApplyResult = {
  state: ContinuousTranscriptState;
  outcome: TranscriptApplyOutcome;
};

export const EMPTY_CONTINUOUS_TRANSCRIPT: ContinuousTranscriptState = {
  active: {},
  finalized: [],
  accepted: {}
};

function sameEvent(left: PublicTranscriptEvent, right: PublicTranscriptEvent): boolean {
  if (left.type !== right.type
    || left.schemaVersion !== right.schemaVersion
    || left.transcriptVersion !== right.transcriptVersion
    || left.meetingId !== right.meetingId
    || left.participantId !== right.participantId
    || left.streamId !== right.streamId
    || left.contributionId !== right.contributionId
    || left.revision !== right.revision
    || left.sequence !== right.sequence
    || left.occurredAt !== right.occurredAt) {
    return false;
  }
  if (left.type === "transcript.cancelled") {
    const cancelledRight = right as TranscriptCancelledEvent;
    return left.payload.reason === cancelledRight.payload.reason
      && left.payload.sourceDisplayName === cancelledRight.payload.sourceDisplayName;
  }
  const textRight = right as TranscriptTextEvent;
  return left.payload.text === textRight.payload.text
    && left.payload.confidence === textRight.payload.confidence
    && left.payload.modelVersion === textRight.payload.modelVersion
    && left.payload.representation === textRight.payload.representation
    && left.payload.representationVersion === textRight.payload.representationVersion
    && left.payload.sourceDisplayName === textRight.payload.sourceDisplayName;
}

function contributionFrom(event: TranscriptTextEvent): TranscriptContribution {
  return {
    contributionId: event.contributionId,
    meetingId: event.meetingId,
    participantId: event.participantId,
    streamId: event.streamId,
    revision: event.revision,
    sequence: event.sequence,
    phase: event.type === "transcript.final" ? "final" : "provisional",
    text: event.payload.text,
    confidence: event.payload.confidence,
    modelVersion: event.payload.modelVersion,
    representation: event.payload.representation,
    representationVersion: event.payload.representationVersion,
    sourceDisplayName: event.payload.sourceDisplayName,
    occurredAt: event.occurredAt
  };
}

function hasMatchingIdentity(
  accepted: PublicTranscriptEvent,
  incoming: PublicTranscriptEvent
): boolean {
  return accepted.meetingId === incoming.meetingId
    && accepted.participantId === incoming.participantId
    && accepted.streamId === incoming.streamId;
}

export function applyTranscriptEvent(
  state: ContinuousTranscriptState,
  event: PublicTranscriptEvent
): TranscriptApplyResult {
  const prior = state.accepted[event.contributionId];
  if (!prior) {
    const mayCreate = event.revision === 0
      && (event.type === "transcript.partial" || event.type === "transcript.final");
    if (!mayCreate) return { state, outcome: "invalid_transition" };

    const contribution = contributionFrom(event);
    return {
      outcome: "applied",
      state: {
        active: event.type === "transcript.final"
          ? state.active
          : { ...state.active, [event.contributionId]: contribution },
        finalized: event.type === "transcript.final"
          ? [...state.finalized, contribution]
          : state.finalized,
        accepted: {
          ...state.accepted,
          [event.contributionId]: { event, terminal: event.type === "transcript.final" }
        }
      }
    };
  }

  if (!hasMatchingIdentity(prior.event, event)) return { state, outcome: "conflict" };
  if (event.revision < prior.event.revision || event.sequence < prior.event.sequence) {
    return { state, outcome: "stale" };
  }
  if (event.revision === prior.event.revision) {
    return { state, outcome: sameEvent(prior.event, event) ? "duplicate" : "conflict" };
  }
  if (prior.terminal) return { state, outcome: "terminal" };
  if (event.sequence <= prior.event.sequence || event.type === "transcript.partial") {
    return { state, outcome: event.type === "transcript.partial" ? "invalid_transition" : "stale" };
  }

  const nextActive = { ...state.active };
  if (event.type === "transcript.cancelled" || event.type === "transcript.final") {
    delete nextActive[event.contributionId];
  } else {
    nextActive[event.contributionId] = contributionFrom(event);
  }

  const finalContribution = event.type === "transcript.final" ? contributionFrom(event) : null;
  return {
    outcome: "applied",
    state: {
      active: nextActive,
      finalized: finalContribution ? [...state.finalized, finalContribution] : state.finalized,
      accepted: {
        ...state.accepted,
        [event.contributionId]: {
          event,
          terminal: event.type === "transcript.final" || event.type === "transcript.cancelled"
        }
      }
    }
  };
}
