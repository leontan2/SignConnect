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
}
