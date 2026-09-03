package com.signconnect.realtime.transcript;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ContinuousTranscriptLifecycleTest {

    private static final UUID MEETING_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID PARTICIPANT_ID = UUID.fromString("22222222-2222-4222-8222-222222222222");
    private static final UUID STREAM_ID = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final UUID CONTRIBUTION_ID = UUID.fromString("44444444-4444-4444-8444-444444444444");
    private static final Instant OCCURRED_AT = Instant.parse("2026-09-03T04:00:00Z");

    @Test
    void acceptsCoalescedRevisionsAndExactReplay() {
        PublicTranscriptEvent partial = textEvent(PublicTranscriptEvent.Type.PARTIAL, 0, 12, "Could you");
        PublicTranscriptEvent revised = textEvent(PublicTranscriptEvent.Type.REVISED, 2, 14, "Could you repeat that?");
        PublicTranscriptEvent finalized = textEvent(PublicTranscriptEvent.Type.FINAL, 3, 15, "Could you repeat that?");

        TranscriptRevisionGuard.Result started = apply(TranscriptRevisionGuard.State.EMPTY, partial);
        TranscriptRevisionGuard.Result updated = apply(started.state(), revised);
        TranscriptRevisionGuard.Result completed = apply(updated.state(), finalized);
        TranscriptRevisionGuard.Result replayed = apply(completed.state(), finalized);

        assertThat(started.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.APPLIED);
        assertThat(updated.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.APPLIED);
        assertThat(updated.state().acceptedRevision(CONTRIBUTION_ID).event()).isEqualTo(revised);
        assertThat(completed.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.APPLIED);
        assertThat(completed.state().acceptedRevision(CONTRIBUTION_ID).terminal()).isTrue();
        assertThat(replayed.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.DUPLICATE);
        assertThat(replayed.state()).isSameAs(completed.state());
    }

    @Test
    void rejectsStaleConflictingIdentityMismatchedAndPostTerminalEvents() {
        PublicTranscriptEvent partial = textEvent(PublicTranscriptEvent.Type.PARTIAL, 0, 12, "Could you");
        PublicTranscriptEvent revised = textEvent(PublicTranscriptEvent.Type.REVISED, 2, 14, "Could you repeat that?");
        TranscriptRevisionGuard.Result updated = apply(apply(TranscriptRevisionGuard.State.EMPTY, partial).state(), revised);

        assertThat(apply(updated.state(), partial).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.STALE);
        assertThat(apply(updated.state(), textEvent(
                PublicTranscriptEvent.Type.REVISED, 2, 14, "Conflicting text")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.CONFLICT);
        assertThat(apply(updated.state(), withParticipant(
                textEvent(PublicTranscriptEvent.Type.FINAL, 3, 15, "Could you repeat that?"),
                UUID.randomUUID())).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.CONFLICT);

        TranscriptRevisionGuard.Result completed = apply(
                updated.state(),
                textEvent(PublicTranscriptEvent.Type.FINAL, 3, 15, "Could you repeat that?"));
        assertThat(apply(completed.state(), textEvent(
                PublicTranscriptEvent.Type.REVISED, 4, 16, "Late rewrite")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.TERMINAL);
    }

    @Test
    void permitsDirectFinalButNotRevisedOrCancelledCreation() {
        PublicTranscriptEvent directFinal = textEvent(PublicTranscriptEvent.Type.FINAL, 0, 12, "Thank you.");
        PublicTranscriptEvent revised = textEvent(PublicTranscriptEvent.Type.REVISED, 1, 13, "Thank you.");
        PublicTranscriptEvent cancelled = cancelledEvent(1, 13);

        assertThat(apply(TranscriptRevisionGuard.State.EMPTY, directFinal).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.APPLIED);
        assertThat(apply(TranscriptRevisionGuard.State.EMPTY, revised).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.INVALID_TRANSITION);
        assertThat(apply(TranscriptRevisionGuard.State.EMPTY, cancelled).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.INVALID_TRANSITION);
    }

    @Test
    void cancellationTerminatesAProvisionalContributionWithoutTextPayload() {
        TranscriptRevisionGuard.Result started = apply(
                TranscriptRevisionGuard.State.EMPTY,
                textEvent(PublicTranscriptEvent.Type.PARTIAL, 0, 12, "Could you"));
        TranscriptRevisionGuard.Result cancelled = apply(started.state(), cancelledEvent(1, 13));

        assertThat(cancelled.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.APPLIED);
        assertThat(cancelled.state().acceptedRevision(CONTRIBUTION_ID).event().payload())
                .isInstanceOf(PublicTranscriptEvent.CancelledPayload.class);
        assertThat(cancelled.state().acceptedRevision(CONTRIBUTION_ID).terminal()).isTrue();
        assertThat(apply(cancelled.state(), textEvent(
                PublicTranscriptEvent.Type.FINAL, 2, 14, "Could you repeat that?")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.TERMINAL);
    }

    @Test
    void rejectsMalformedWireValuesWithoutMutatingState() {
        PublicTranscriptEvent valid = textEvent(PublicTranscriptEvent.Type.PARTIAL, 0, 12, "Could you");
        TranscriptRevisionGuard.State state = apply(TranscriptRevisionGuard.State.EMPTY, valid).state();

        assertInvalid(state, withText(valid, "   "));
        assertInvalid(state, withConfidence(valid, Double.NaN));
        assertInvalid(state, withConfidence(valid, 1.01));
        assertInvalid(state, withModelVersion(valid, "not allowed"));
        assertInvalid(state, withText(valid, "Unsafe\u0000text"));
        assertInvalid(state, new PublicTranscriptEvent(
                1, 1, PublicTranscriptEvent.Type.CANCELLED,
                MEETING_ID, PARTICIPANT_ID, STREAM_ID, CONTRIBUTION_ID,
                0, 13,
                new PublicTranscriptEvent.CancelledPayload(
                        PublicTranscriptEvent.CancellationReason.UNCERTAIN, "Signer"),
                OCCURRED_AT));
    }

    @Test
    void higherRevisionsRequireIncreasingSequenceAndCannotReturnToPartial() {
        TranscriptRevisionGuard.Result started = apply(
                TranscriptRevisionGuard.State.EMPTY,
                textEvent(PublicTranscriptEvent.Type.PARTIAL, 0, 12, "Could you"));

        assertThat(apply(started.state(), textEvent(
                PublicTranscriptEvent.Type.REVISED, 1, 12, "Could you repeat")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.STALE);
        assertThat(apply(started.state(), textEvent(
                PublicTranscriptEvent.Type.PARTIAL, 1, 12, "Could you repeat")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.INVALID_TRANSITION);
        assertThat(apply(started.state(), textEvent(
                PublicTranscriptEvent.Type.PARTIAL, 1, 13, "Could you repeat")).outcome())
                .isEqualTo(TranscriptRevisionGuard.Outcome.INVALID_TRANSITION);
    }

    private static TranscriptRevisionGuard.Result apply(
            TranscriptRevisionGuard.State state,
            PublicTranscriptEvent event) {
        return TranscriptRevisionGuard.apply(state, event);
    }

    private static PublicTranscriptEvent textEvent(
            PublicTranscriptEvent.Type type,
            long revision,
            long sequence,
            String text) {
        return new PublicTranscriptEvent(
                1,
                1,
                type,
                MEETING_ID,
                PARTICIPANT_ID,
                STREAM_ID,
                CONTRIBUTION_ID,
                revision,
                sequence,
                new PublicTranscriptEvent.TextPayload(
                        text,
                        0.92,
                        "continuous-alpha-0.1",
                        PublicTranscriptEvent.Representation.DIRECT_TEXT,
                        "direct-text-v1",
                        "Signer"),
                OCCURRED_AT.plusSeconds(sequence));
    }

    private static PublicTranscriptEvent cancelledEvent(long revision, long sequence) {
        return new PublicTranscriptEvent(
                1,
                1,
                PublicTranscriptEvent.Type.CANCELLED,
                MEETING_ID,
                PARTICIPANT_ID,
                STREAM_ID,
                CONTRIBUTION_ID,
                revision,
                sequence,
                new PublicTranscriptEvent.CancelledPayload(
                        PublicTranscriptEvent.CancellationReason.UNCERTAIN,
                        "Signer"),
                OCCURRED_AT.plusSeconds(sequence));
    }

    private static PublicTranscriptEvent withParticipant(PublicTranscriptEvent event, UUID participantId) {
        return new PublicTranscriptEvent(
                event.schemaVersion(), event.transcriptVersion(), event.type(), event.meetingId(),
                participantId, event.streamId(), event.contributionId(), event.revision(),
                event.sequence(), event.payload(), event.occurredAt());
    }

    private static PublicTranscriptEvent withText(PublicTranscriptEvent event, String text) {
        PublicTranscriptEvent.TextPayload payload = (PublicTranscriptEvent.TextPayload) event.payload();
        return withPayload(event, new PublicTranscriptEvent.TextPayload(
                text, payload.confidence(), payload.modelVersion(), payload.representation(),
                payload.representationVersion(), payload.sourceDisplayName()));
    }

    private static PublicTranscriptEvent withConfidence(PublicTranscriptEvent event, double confidence) {
        PublicTranscriptEvent.TextPayload payload = (PublicTranscriptEvent.TextPayload) event.payload();
        return withPayload(event, new PublicTranscriptEvent.TextPayload(
                payload.text(), confidence, payload.modelVersion(), payload.representation(),
                payload.representationVersion(), payload.sourceDisplayName()));
    }

    private static PublicTranscriptEvent withModelVersion(PublicTranscriptEvent event, String modelVersion) {
        PublicTranscriptEvent.TextPayload payload = (PublicTranscriptEvent.TextPayload) event.payload();
        return withPayload(event, new PublicTranscriptEvent.TextPayload(
                payload.text(), payload.confidence(), modelVersion, payload.representation(),
                payload.representationVersion(), payload.sourceDisplayName()));
    }

    private static PublicTranscriptEvent withPayload(
            PublicTranscriptEvent event,
            PublicTranscriptEvent.Payload payload) {
        return new PublicTranscriptEvent(
                event.schemaVersion(), event.transcriptVersion(), event.type(), event.meetingId(),
                event.participantId(), event.streamId(), event.contributionId(), event.revision(),
                event.sequence(), payload, event.occurredAt());
    }

    private static void assertInvalid(
            TranscriptRevisionGuard.State state,
            PublicTranscriptEvent event) {
        TranscriptRevisionGuard.Result result = apply(state, event);
        assertThat(result.outcome()).isEqualTo(TranscriptRevisionGuard.Outcome.INVALID_EVENT);
        assertThat(result.state()).isSameAs(state);
    }
}
