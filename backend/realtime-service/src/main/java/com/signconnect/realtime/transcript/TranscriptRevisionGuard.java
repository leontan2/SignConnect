package com.signconnect.realtime.transcript;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Pure revision state machine for the proposed continuous transcript contract.
 * It has no Spring annotation and no production event-publication integration.
 */
public final class TranscriptRevisionGuard {

    private TranscriptRevisionGuard() {
    }

    public enum Outcome {
        APPLIED,
        DUPLICATE,
        STALE,
        CONFLICT,
        TERMINAL,
        INVALID_EVENT,
        INVALID_TRANSITION
    }

    public record AcceptedRevision(PublicTranscriptEvent event, boolean terminal) {
        public AcceptedRevision {
            if (event == null) {
                throw new IllegalArgumentException("Accepted event is required");
            }
        }
    }

    public record State(Map<UUID, AcceptedRevision> accepted) {
        public static final State EMPTY = new State(Map.of());

        public State {
            accepted = Map.copyOf(accepted);
        }

        public AcceptedRevision acceptedRevision(UUID contributionId) {
            return accepted.get(contributionId);
        }
    }

    public record Result(State state, Outcome outcome) {
    }

    public static Result apply(State state, PublicTranscriptEvent event) {
        if (state == null || event == null || !event.hasValidContract()) {
            return new Result(state, Outcome.INVALID_EVENT);
        }

        AcceptedRevision prior = state.acceptedRevision(event.contributionId());
        if (prior == null) {
            boolean mayCreate = event.revision() == 0
                    && (event.type() == PublicTranscriptEvent.Type.PARTIAL
                    || event.type() == PublicTranscriptEvent.Type.FINAL);
            if (!mayCreate) {
                return new Result(state, Outcome.INVALID_TRANSITION);
            }
            return applied(state, event);
        }

        if (!sameIdentity(prior.event(), event)) {
            return new Result(state, Outcome.CONFLICT);
        }
        if (event.revision() < prior.event().revision()
                || event.sequence() < prior.event().sequence()) {
            return new Result(state, Outcome.STALE);
        }
        if (event.revision() == prior.event().revision()) {
            return new Result(
                    state,
                    event.equals(prior.event()) ? Outcome.DUPLICATE : Outcome.CONFLICT);
        }
        if (prior.terminal()) {
            return new Result(state, Outcome.TERMINAL);
        }
        if (event.sequence() <= prior.event().sequence()
                || event.type() == PublicTranscriptEvent.Type.PARTIAL) {
            return new Result(
                    state,
                    event.type() == PublicTranscriptEvent.Type.PARTIAL
                            ? Outcome.INVALID_TRANSITION
                            : Outcome.STALE);
        }
        return applied(state, event);
    }

    private static Result applied(State state, PublicTranscriptEvent event) {
        Map<UUID, AcceptedRevision> next = new LinkedHashMap<>(state.accepted());
        next.put(
                event.contributionId(),
                new AcceptedRevision(event, event.type().terminal()));
        return new Result(new State(next), Outcome.APPLIED);
    }

    private static boolean sameIdentity(
            PublicTranscriptEvent accepted,
            PublicTranscriptEvent incoming) {
        return accepted.meetingId().equals(incoming.meetingId())
                && accepted.participantId().equals(incoming.participantId())
                && accepted.streamId().equals(incoming.streamId());
    }
}
