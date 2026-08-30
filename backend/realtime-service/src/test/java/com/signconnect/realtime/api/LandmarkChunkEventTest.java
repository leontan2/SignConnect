package com.signconnect.realtime.api;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class LandmarkChunkEventTest {

    @Test
    void acceptsTheBoundedNormalizedOriginSentinelForAMissingLandmark() {
        List<Double> features = new ArrayList<>(
                java.util.Collections.nCopies(LandmarkChunkEvent.FEATURES_PER_FRAME, 0.0));
        features.set(0, -1.0);
        features.set(1, -1.0);
        features.set(2, -0.2);
        List<LandmarkChunkEvent.Frame> frames = IntStream.range(0, 5)
                .mapToObj(index -> new LandmarkChunkEvent.Frame(
                        (long) index, index * 40.0, List.copyOf(features)))
                .toList();
        LandmarkChunkEvent event = new LandmarkChunkEvent(
                1,
                "landmark.chunk",
                UUID.fromString("11111111-1111-4111-8111-111111111111"),
                0L,
                frames);

        assertThat(event.hasValidContract()).isTrue();
    }
}
