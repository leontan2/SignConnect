package com.signconnect.inference.model;

import com.signconnect.inference.config.InferenceLimitsProperties;
import org.springframework.stereotype.Component;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@Component
public final class InferenceConcurrencyLimiter {

    private final Semaphore permits;
    private final long acquireTimeoutMs;

    public InferenceConcurrencyLimiter(InferenceLimitsProperties limits) {
        this.permits = new Semaphore(limits.maxConcurrentPredictions(), true);
        this.acquireTimeoutMs = limits.concurrencyAcquireTimeoutMs();
    }

    public Lease acquire() {
        boolean acquired;
        try {
            acquired = permits.tryAcquire(acquireTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new InferenceBusyException();
        }
        if (!acquired) {
            throw new InferenceBusyException();
        }
        return new Lease(permits);
    }

    int availablePermits() {
        return permits.availablePermits();
    }

    public static final class Lease implements AutoCloseable {

        private final Semaphore permits;
        private final AtomicBoolean closed = new AtomicBoolean();

        private Lease(Semaphore permits) {
            this.permits = permits;
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                permits.release();
            }
        }
    }

    public static final class InferenceBusyException extends RuntimeException {

        public InferenceBusyException() {
            super("Inference capacity is busy");
        }
    }
}
