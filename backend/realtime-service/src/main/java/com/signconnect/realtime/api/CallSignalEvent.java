package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import java.util.Set;
import java.util.UUID;

public record CallSignalEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID signalId,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID callId,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID targetParticipantId,
        JsonNode payload) {

    private static final Set<String> TYPES = Set.of(
            "call.offer", "call.answer", "call.ice-candidate", "call.decline", "call.leave", "media.state");

    public boolean hasValidContract() {
        if (schemaVersion == null
                || schemaVersion != LandmarkChunkEvent.SCHEMA_VERSION
                || !TYPES.contains(type)
                || signalId == null
                || callId == null
                || targetParticipantId == null
                || payload == null
                || !payload.isObject()) {
            return false;
        }
        return switch (type) {
            case "call.offer", "call.answer" -> exactKeys(payload, Set.of("sdp"))
                    && validText(payload.path("sdp"), 1, 65_535);
            case "call.ice-candidate" -> validIceCandidate(payload);
            case "call.decline", "call.leave" -> exactKeys(payload, Set.of("reason"))
                    && validText(payload.path("reason"), 1, 100);
            case "media.state" -> exactKeys(payload, Set.of("audioEnabled", "videoEnabled"))
                    && payload.path("audioEnabled").isBoolean()
                    && payload.path("videoEnabled").isBoolean();
            default -> false;
        };
    }

    private static boolean validIceCandidate(JsonNode value) {
        Set<String> allowed = Set.of("candidate", "sdpMid", "sdpMLineIndex", "usernameFragment");
        if (!value.fieldNames().hasNext()
                || !stream(value).allMatch(allowed::contains)
                || !validText(value.path("candidate"), 0, 8_192)) {
            return false;
        }
        JsonNode mid = value.get("sdpMid");
        JsonNode line = value.get("sdpMLineIndex");
        JsonNode fragment = value.get("usernameFragment");
        return (mid == null || mid.isNull() || validText(mid, 0, 256))
                && (line == null || line.isNull() || (line.canConvertToInt() && line.intValue() >= 0))
                && (fragment == null || fragment.isNull() || validText(fragment, 0, 256));
    }

    private static boolean exactKeys(JsonNode value, Set<String> keys) {
        return value.size() == keys.size() && stream(value).allMatch(keys::contains);
    }

    private static java.util.stream.Stream<String> stream(JsonNode value) {
        java.util.Spliterator<String> spliterator = java.util.Spliterators.spliteratorUnknownSize(
                value.fieldNames(), java.util.Spliterator.ORDERED);
        return java.util.stream.StreamSupport.stream(spliterator, false);
    }

    private static boolean validText(JsonNode value, int minimum, int maximum) {
        if (!value.isTextual()) {
            return false;
        }
        int length = value.textValue().codePointCount(0, value.textValue().length());
        return length >= minimum && length <= maximum;
    }
}
