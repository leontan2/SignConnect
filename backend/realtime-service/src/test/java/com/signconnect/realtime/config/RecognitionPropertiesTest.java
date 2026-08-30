package com.signconnect.realtime.config;

import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

import static org.assertj.core.api.Assertions.assertThat;

class RecognitionPropertiesTest {

    @Test
    void requiresAThirtyTwoKilobyteLogicalLimitForOneValidV1Chunk() {
        RecognitionProperties properties = new RecognitionProperties();

        properties.setMaxMessageSize(DataSize.ofBytes(32L * 1_024L - 1L));
        assertThat(properties.isSafeConfiguration()).isFalse();

        properties.setMaxMessageSize(DataSize.ofKilobytes(32));
        assertThat(properties.isSafeConfiguration()).isTrue();
    }

    @Test
    void defaultsToSegmentedGesturesAndRequiresNonOverlappingThirtyFrameCandidates() {
        RecognitionProperties properties = new RecognitionProperties();

        assertThat(properties.getInputMode())
                .isEqualTo(RecognitionProperties.InputMode.SEGMENTED_GESTURES);
        assertThat(properties.effectiveStrideFrames()).isEqualTo(30);

        properties.setInputMode(RecognitionProperties.InputMode.ROLLING);
        assertThat(properties.effectiveStrideFrames()).isEqualTo(5);
        assertThat(properties.isSafeConfiguration()).isTrue();
    }
}
