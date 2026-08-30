package com.signconnect.inference.model;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CanonicalModelDecisionTest {

    @Test
    void onlyRecognizedSignsRetainCaptionCandidateFieldsOnTheWire() {
        ModelContract.Label hello = new ModelContract.Label(
                1, "HELLO", "Hello.", ModelContract.LabelOutcome.SIGN);

        CanonicalModelDecision recognized = CanonicalModelDecision.from(hello, 0.91, 0.8);
        CanonicalModelDecision lowConfidence = CanonicalModelDecision.from(hello, 0.79, 0.8);

        assertThat(recognized.outcome()).isEqualTo(CanonicalModelDecision.Outcome.RECOGNIZED);
        assertThat(recognized.canBecomeCaptionCandidate()).isTrue();
        assertThat(recognized.wireLabelId()).isEqualTo("HELLO");
        assertThat(recognized.wireCaptionText()).isEqualTo("Hello.");
        assertThat(lowConfidence.outcome()).isEqualTo(CanonicalModelDecision.Outcome.LOW_CONFIDENCE);
        assertThat(lowConfidence.canBecomeCaptionCandidate()).isFalse();
        assertThat(lowConfidence.wireLabelId()).isEqualTo("NO_SIGN");
        assertThat(lowConfidence.wireCaptionText()).isNull();
    }

    @Test
    void collapsesNoSignAndExplicitRejectionToTheV1NoCaptionWireShape() {
        ModelContract.Label noSign = new ModelContract.Label(
                0, "NO_SIGN", null, ModelContract.LabelOutcome.NO_SIGN);
        ModelContract.Label rejection = new ModelContract.Label(
                2, "OUT_OF_VOCABULARY", null, ModelContract.LabelOutcome.REJECT);

        CanonicalModelDecision idle = CanonicalModelDecision.from(noSign, 0.97, 0.8);
        CanonicalModelDecision rejected = CanonicalModelDecision.from(rejection, 0.93, 0.8);

        assertThat(idle.outcome()).isEqualTo(CanonicalModelDecision.Outcome.NO_SIGN);
        assertThat(rejected.outcome()).isEqualTo(CanonicalModelDecision.Outcome.REJECTED);
        assertThat(idle.canBecomeCaptionCandidate()).isFalse();
        assertThat(rejected.canBecomeCaptionCandidate()).isFalse();
        // The frozen v1 response has no outcome discriminator. Both safe terminal outcomes must
        // therefore cross that boundary as NO_SIGN with a null caption candidate.
        assertThat(idle.wireLabelId()).isEqualTo("NO_SIGN");
        assertThat(rejected.wireLabelId()).isEqualTo("NO_SIGN");
        assertThat(idle.wireCaptionText()).isNull();
        assertThat(rejected.wireCaptionText()).isNull();
    }

    @Test
    void representsUnavailableRuntimeWithoutAWirePredictionCandidate() {
        CanonicalModelDecision unavailable = CanonicalModelDecision.unavailable();

        assertThat(unavailable.outcome())
                .isEqualTo(CanonicalModelDecision.Outcome.MODEL_UNAVAILABLE);
        assertThat(unavailable.canBecomeCaptionCandidate()).isFalse();
        assertThat(unavailable.wireLabelId()).isNull();
        assertThat(unavailable.wireCaptionText()).isNull();
    }
}
