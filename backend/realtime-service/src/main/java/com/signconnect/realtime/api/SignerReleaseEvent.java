package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import java.util.UUID;

public record SignerReleaseEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID streamId,
        Long sequence,
        Double timestampMs,
        String reason) {

    public boolean hasValidContract() {
        return schemaVersion != null && schemaVersion == LandmarkChunkEvent.SCHEMA_VERSION
                && "signer.release".equals(type)
                && streamId != null
                && sequence != null && sequence >= 0
                && timestampMs != null && Double.isFinite(timestampMs) && timestampMs >= 0
                && ("recognition_stopped".equals(reason) || "user_request".equals(reason));
    }
}
