package com.signconnect.inference.model;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

@Component("modelReadiness")
public class ModelReadinessHealthIndicator implements HealthIndicator {

    private final OnnxModelRuntime modelRuntime;

    public ModelReadinessHealthIndicator(OnnxModelRuntime modelRuntime) {
        this.modelRuntime = modelRuntime;
    }

    @Override
    public Health health() {
        boolean ready = modelRuntime.isReady();
        Health.Builder health = ready ? Health.up() : Health.down();
        health.withDetail("ready", ready)
                .withDetail("mode", modelRuntime.modelMode())
                .withDetail("predictionCount", modelRuntime.predictionCount());
        return health.build();
    }
}
