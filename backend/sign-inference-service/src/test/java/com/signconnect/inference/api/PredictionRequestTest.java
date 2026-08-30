package com.signconnect.inference.api;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;

class PredictionRequestTest {

    @Test
    void acceptsTheBoundedNormalizedOriginSentinelForAMissingLandmark() {
        List<Double> features = new ArrayList<>(
                java.util.Collections.nCopies(PredictionRequest.FEATURE_COUNT, 0.0));
        features.set(0, -1.0);
        features.set(1, -1.0);
        features.set(2, -0.2);
        List<PredictionRequest.Frame> frames = IntStream.range(0, 30)
                .mapToObj(index -> new PredictionRequest.Frame(
                        (long) index, index * 40.0, List.copyOf(features)))
                .toList();
        PredictionRequest request = new PredictionRequest(
                1,
                UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                UUID.fromString("11111111-1111-4111-8111-111111111111"),
                0L,
                frames);

        assertThat(request.hasValidInferenceContract()).isTrue();
    }
}
