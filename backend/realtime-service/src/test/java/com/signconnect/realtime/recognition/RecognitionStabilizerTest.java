package com.signconnect.realtime.recognition;

import com.signconnect.realtime.config.RecognitionProperties;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RecognitionStabilizerTest {

    private static final UUID REQUEST_ID = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-000000000001");
    private static final UUID STREAM_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Test
    void finalizesOnlyAfterThreeSameConfidentActivesAndTwoConfidentIdleEvaluations() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(stabilizer.evaluate(active(0, "MOCK_ACTIVE", 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(1, "MOCK_ACTIVE", 0.96)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction stablePrediction = active(2, "MOCK_ACTIVE", 0.97);
        assertThat(stabilizer.evaluate(stablePrediction))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(3)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        assertThat(stabilizer.evaluate(idle(4)))
                .isEqualTo(new RecognitionStabilizer.Final(stablePrediction, NOW));
    }

    @Test
    void lowConfidenceBreaksTheConsecutiveRunAndTheThresholdIsInclusive() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(stabilizer.evaluate(active(0, "MOCK_ACTIVE", 0.80)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(1, "MOCK_ACTIVE", 0.80)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(2, "MOCK_ACTIVE", 0.799)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(3, "MOCK_ACTIVE", 0.80)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(4)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(5)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
    }

    @Test
    void suppressesSameLabelOccurrencesUntilTheCooldownBoundary() {
        MutableClock clock = new MutableClock(NOW, ZoneOffset.UTC);
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(clock);

        RecognitionStabilizer.Outcome first = occurrence(stabilizer, 0, "MOCK_ACTIVE");
        assertThat(first).isInstanceOf(RecognitionStabilizer.Final.class);
        assertThat(occurrence(stabilizer, 5, "MOCK_ACTIVE"))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        clock.advance(Duration.ofMillis(1_499));
        assertThat(occurrence(stabilizer, 10, "MOCK_ACTIVE"))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        clock.advance(Duration.ofMillis(1));
        assertThat(occurrence(stabilizer, 15, "MOCK_ACTIVE"))
                .isEqualTo(new RecognitionStabilizer.Final(
                        active(17, "MOCK_ACTIVE", 0.95),
                        NOW.plusMillis(1_500)));
    }

    @Test
    void emitsRepeatedLowConfidenceActivityOnlyAfterFailuresAndAtMostEveryTwoSeconds() {
        MutableClock clock = new MutableClock(NOW, ZoneOffset.UTC);
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(clock);

        assertThat(stabilizer.evaluate(active(0, "MOCK_ACTIVE", 0.42)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(1, "MOCK_ACTIVE", 0.43)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction thirdFailure = active(2, "MOCK_ACTIVE", 0.44);
        assertThat(stabilizer.evaluate(thirdFailure))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        thirdFailure,
                        NOW));

        assertThat(stabilizer.evaluate(active(3, "MOCK_ACTIVE", 0.45)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        clock.advance(Duration.ofMillis(1_999));
        assertThat(stabilizer.evaluate(active(4, "MOCK_ACTIVE", 0.46)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        clock.advance(Duration.ofMillis(1));
        RecognitionStabilizer.Prediction nextEligible = active(5, "MOCK_ACTIVE", 0.47);
        assertThat(stabilizer.evaluate(nextEligible))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        nextEligible,
                        NOW.plusSeconds(2)));
    }

    @Test
    void treatsRepeatedNoSignAsUnknownWhileRecentHandsRemainPresent() {
        MutableClock clock = new MutableClock(NOW, ZoneOffset.UTC);
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(clock);

        assertThat(stabilizer.evaluate(idle(0), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(1), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction thirdFailure = idle(2);
        assertThat(stabilizer.evaluate(thirdFailure, true))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        thirdFailure,
                        NOW));

        assertThat(stabilizer.evaluate(idle(3), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        clock.advance(Duration.ofSeconds(2));
        RecognitionStabilizer.Prediction nextEligible = idle(4);
        assertThat(stabilizer.evaluate(nextEligible, true))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        nextEligible,
                        NOW.plusSeconds(2)));
    }

    @Test
    void onlyHandFreeNoSignWindowsFinalizeAnArmedOccurrence() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));
        RecognitionStabilizer.Prediction stable = active(2, "MOCK_ACTIVE", 0.95);

        assertThat(stabilizer.evaluate(active(0, "MOCK_ACTIVE", 0.95), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(1, "MOCK_ACTIVE", 0.95), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(stable, true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(3), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(4), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(5), false))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        assertThat(stabilizer.evaluate(idle(6), false))
                .isEqualTo(new RecognitionStabilizer.Final(stable, NOW));
    }

    @Test
    void handFreeNoSignCountsAsIdleRegardlessOfModelConfidence() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));
        RecognitionStabilizer.Prediction stable = active(2, "MOCK_ACTIVE", 0.95);

        stabilizer.evaluate(active(0, "MOCK_ACTIVE", 0.95), true);
        stabilizer.evaluate(active(1, "MOCK_ACTIVE", 0.95), true);
        stabilizer.evaluate(stable, true);

        assertThat(stabilizer.evaluate(idle(3, 0.05), false))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(4, 0.01), false))
                .isEqualTo(new RecognitionStabilizer.Final(stable, NOW));
    }

    @Test
    void repeatedConflictingTrackedActivityDisarmsAStaleOccurrence() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        stabilizer.evaluate(active(0, "ALPHA", 0.95), true);
        stabilizer.evaluate(active(1, "ALPHA", 0.95), true);
        stabilizer.evaluate(active(2, "ALPHA", 0.95), true);
        assertThat(stabilizer.evaluate(active(3, "BRAVO", 0.95), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(4, "BRAVO", 0.95), true))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction conflict = active(5, "BRAVO", 0.95);
        assertThat(stabilizer.evaluate(conflict, true))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.UNSTABLE_PREDICTION,
                        conflict,
                        NOW));

        assertThat(stabilizer.evaluate(idle(6, 0.99), false))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(7, 0.99), false))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
    }

    @Test
    void reportsRepeatedConfidentLabelChangesAsUnstable() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(stabilizer.evaluate(active(0, "ALPHA", 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(1, "BRAVO", 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(2, "ALPHA", 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction thirdChange = active(3, "BRAVO", 0.95);

        assertThat(stabilizer.evaluate(thirdChange))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.UNSTABLE_PREDICTION,
                        thirdChange,
                        NOW));
    }

    @Test
    void heldActivityCannotFinalizeAndAnInterruptedIdleRunMustRestart() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        for (int index = 0; index < 8; index++) {
            assertThat(stabilizer.evaluate(active(index, "MOCK_ACTIVE", 0.95)))
                    .isSameAs(RecognitionStabilizer.None.INSTANCE);
        }
        assertThat(stabilizer.evaluate(idle(8)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(9, "MOCK_ACTIVE", 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(10)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);

        assertThat(stabilizer.evaluate(idle(11)))
                .isEqualTo(new RecognitionStabilizer.Final(
                        active(2, "MOCK_ACTIVE", 0.95),
                        NOW));
    }

    @Test
    void cooldownAppliesOnlyToTheSameLabel() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(occurrence(stabilizer, 0, "ALPHA"))
                .isInstanceOf(RecognitionStabilizer.Final.class);
        assertThat(occurrence(stabilizer, 5, "BRAVO"))
                .isEqualTo(new RecognitionStabilizer.Final(
                        active(7, "BRAVO", 0.95),
                        NOW));
    }

    @Test
    void completedGesturesFinalizeImmediatelyAndAllowTheSameSignAfterAnIdleBoundary() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));
        RecognitionStabilizer.Prediction first = active(0, "MOCK_ACTIVE", 0.95);
        RecognitionStabilizer.Prediction repeated = active(1, "MOCK_ACTIVE", 0.96);

        assertThat(stabilizer.evaluateCompletedGesture(first))
                .isEqualTo(new RecognitionStabilizer.Final(first, NOW));
        assertThat(stabilizer.evaluateCompletedGesture(repeated))
                .isEqualTo(new RecognitionStabilizer.Final(repeated, NOW));
    }

    @Test
    void completedGesturesImmediatelyRejectNoSignAndLowConfidencePredictions() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));
        RecognitionStabilizer.Prediction noSign = idle(0);
        RecognitionStabilizer.Prediction lowConfidence = active(1, "MOCK_ACTIVE", 0.79);

        assertThat(stabilizer.evaluateCompletedGesture(noSign))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        noSign,
                        NOW));
        assertThat(stabilizer.evaluateCompletedGesture(lowConfidence))
                .isEqualTo(new RecognitionStabilizer.Unknown(
                        RecognitionStabilizer.UnknownReason.LOW_CONFIDENCE,
                        lowConfidence,
                        NOW));
    }

    @Test
    void resetClearsPendingOccurrenceDeduplicationAndUnknownRateState() {
        RecognitionStabilizer stabilizer = new RecognitionStabilizer(
                Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(occurrence(stabilizer, 0, "MOCK_ACTIVE"))
                .isInstanceOf(RecognitionStabilizer.Final.class);
        stabilizer.evaluate(active(5, "MOCK_ACTIVE", 0.42));
        stabilizer.evaluate(active(6, "MOCK_ACTIVE", 0.42));
        assertThat(stabilizer.evaluate(active(7, "MOCK_ACTIVE", 0.42)))
                .isInstanceOf(RecognitionStabilizer.Unknown.class);

        stabilizer.reset();

        assertThat(occurrence(stabilizer, 8, "MOCK_ACTIVE"))
                .isEqualTo(new RecognitionStabilizer.Final(
                        active(10, "MOCK_ACTIVE", 0.95),
                        NOW));
        assertThat(stabilizer.evaluate(active(13, "MOCK_ACTIVE", 0.42)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(14, "MOCK_ACTIVE", 0.42)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(15, "MOCK_ACTIVE", 0.42)))
                .isInstanceOf(RecognitionStabilizer.Unknown.class);
    }

    @Test
    void rejectsUnsafeThresholdAndCooldownBeforeARecognitionSessionStarts() {
        RecognitionProperties properties = new RecognitionProperties();
        assertThat(properties.isSafeConfiguration()).isTrue();

        properties.setConfidenceThreshold(0.79);
        assertThat(properties.isSafeConfiguration()).isFalse();
        properties.setConfidenceThreshold(0.80);

        properties.setDuplicateCooldown(Duration.ZERO);
        assertThat(properties.isSafeConfiguration()).isFalse();
        properties.setDuplicateCooldown(Duration.ofDays(365));
        assertThat(properties.isSafeConfiguration()).isFalse();

        assertThatThrownBy(() -> new RecognitionStabilizer.Settings(
                0.80, 3, 2, Duration.ZERO, 3, Duration.ofSeconds(2)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new RecognitionStabilizer.Settings(
                0.80, 3, 2, Duration.ofDays(365), 3, Duration.ofSeconds(2)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static RecognitionStabilizer.Outcome occurrence(
            RecognitionStabilizer stabilizer,
            long firstWindowSequence,
            String labelId) {
        assertThat(stabilizer.evaluate(active(firstWindowSequence, labelId, 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(active(firstWindowSequence + 1, labelId, 0.95)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        RecognitionStabilizer.Prediction stable = active(firstWindowSequence + 2, labelId, 0.95);
        assertThat(stabilizer.evaluate(stable))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        assertThat(stabilizer.evaluate(idle(firstWindowSequence + 3)))
                .isSameAs(RecognitionStabilizer.None.INSTANCE);
        return stabilizer.evaluate(idle(firstWindowSequence + 4));
    }

    private static RecognitionStabilizer.Prediction active(
            long windowSequence,
            String labelId,
            double confidence) {
        return new RecognitionStabilizer.Prediction(
                1,
                REQUEST_ID,
                STREAM_ID,
                windowSequence,
                labelId,
                "Caption for " + labelId,
                confidence,
                "synthetic-v1",
                3.5,
                true);
    }

    private static RecognitionStabilizer.Prediction idle(long windowSequence, double confidence) {
        return new RecognitionStabilizer.Prediction(
                1,
                REQUEST_ID,
                STREAM_ID,
                windowSequence,
                "NO_SIGN",
                null,
                confidence,
                "synthetic-v1",
                4.5,
                true);
    }

    private static RecognitionStabilizer.Prediction idle(long windowSequence) {
        return new RecognitionStabilizer.Prediction(
                1,
                REQUEST_ID,
                STREAM_ID,
                windowSequence,
                "NO_SIGN",
                null,
                0.99,
                "synthetic-v1",
                2.0,
                true);
    }

    private static final class MutableClock extends Clock {

        private final AtomicReference<Instant> instant;
        private final ZoneId zone;

        private MutableClock(Instant instant, ZoneId zone) {
            this.instant = new AtomicReference<>(instant);
            this.zone = zone;
        }

        private void advance(Duration duration) {
            instant.updateAndGet(value -> value.plus(duration));
        }

        @Override
        public ZoneId getZone() {
            return zone;
        }

        @Override
        public Clock withZone(ZoneId requestedZone) {
            return new MutableClock(instant(), requestedZone);
        }

        @Override
        public Instant instant() {
            return instant.get();
        }
    }
}
