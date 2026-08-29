package com.signconnect.inference.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "signconnect.inference.limits")
public record InferenceLimitsProperties(
        @NotNull @Min(65_536) @Max(1_048_576) Integer maxRequestBodyBytes,
        @NotNull @Min(1) @Max(16) Integer maxConcurrentPredictions,
        @NotNull @Min(0) @Max(1_000) Long concurrencyAcquireTimeoutMs) {
}
