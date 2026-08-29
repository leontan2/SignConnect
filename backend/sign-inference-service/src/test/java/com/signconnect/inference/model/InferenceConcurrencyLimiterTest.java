package com.signconnect.inference.model;

import com.signconnect.inference.config.InferenceLimitsProperties;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InferenceConcurrencyLimiterTest {

    @Test
    void rejectsBeyondTheConfiguredBoundAndRestoresCapacityExactlyOnce() {
        InferenceConcurrencyLimiter limiter = new InferenceConcurrencyLimiter(limits(1, 0));

        InferenceConcurrencyLimiter.Lease first = limiter.acquire();
        assertThat(limiter.availablePermits()).isZero();
        assertThatThrownBy(limiter::acquire)
                .isInstanceOf(InferenceConcurrencyLimiter.InferenceBusyException.class)
                .hasMessage("Inference capacity is busy");

        first.close();
        first.close();
        assertThat(limiter.availablePermits()).isOne();

        try (InferenceConcurrencyLimiter.Lease ignored = limiter.acquire()) {
            assertThat(limiter.availablePermits()).isZero();
        }
        assertThat(limiter.availablePermits()).isOne();
    }

    @Test
    void validatesEveryResourceLimitAtItsLowerAndUpperBounds() {
        Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

        assertThat(validator.validate(new InferenceLimitsProperties(65_535, 4, 250L))).isNotEmpty();
        assertThat(validator.validate(new InferenceLimitsProperties(1_048_577, 4, 250L))).isNotEmpty();
        assertThat(validator.validate(new InferenceLimitsProperties(262_144, 0, 250L))).isNotEmpty();
        assertThat(validator.validate(new InferenceLimitsProperties(262_144, 17, 250L))).isNotEmpty();
        assertThat(validator.validate(new InferenceLimitsProperties(262_144, 4, -1L))).isNotEmpty();
        assertThat(validator.validate(new InferenceLimitsProperties(262_144, 4, 1_001L))).isNotEmpty();
        assertThat(validator.validate(limits(4, 250))).isEmpty();
    }

    private static InferenceLimitsProperties limits(int concurrency, long timeoutMs) {
        return new InferenceLimitsProperties(262_144, concurrency, timeoutMs);
    }
}
