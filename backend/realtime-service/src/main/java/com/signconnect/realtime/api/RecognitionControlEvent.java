package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import java.util.UUID;

public record RecognitionControlEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID streamId,
        Long sequence,
        Double timestampMs,
        String action) {

    public boolean hasValidContract() {
        return schemaVersion != null && schemaVersion == LandmarkChunkEvent.SCHEMA_VERSION
                && "recognition.control".equals(type)
                && streamId != null
                && sequence != null && sequence >= 0
                && timestampMs != null && Double.isFinite(timestampMs) && timestampMs >= 0
                && ("start".equals(action) || "stop".equals(action));
    }

    @Override
    public String toString() {
        return "RecognitionControlEvent[redacted]";
    }
}
