package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import java.util.UUID;

public record SignerRequestEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID requestId,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID streamId,
        Long sequence,
        Double timestampMs) {

    public boolean hasValidContract() {
        return schemaVersion != null && schemaVersion == LandmarkChunkEvent.SCHEMA_VERSION
                && "signer.request".equals(type)
                && requestId != null
                && streamId != null
                && sequence != null && sequence >= 0
                && timestampMs != null && Double.isFinite(timestampMs) && timestampMs >= 0;
    }
}
