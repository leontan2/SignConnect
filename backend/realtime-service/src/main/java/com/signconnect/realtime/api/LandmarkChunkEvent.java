package com.signconnect.realtime.api;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;

import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

public record LandmarkChunkEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID streamId,
        Long sequence,
        List<Frame> frames) {

    public static final int SCHEMA_VERSION = 1;
    public static final int FRAMES_PER_CHUNK = 5;
    public static final int FEATURES_PER_FRAME = 224;
    private static final double MAX_ABSOLUTE_NORMALIZED_COORDINATE = 20.0;
    private static final Pattern CANONICAL_UUID = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    public boolean hasValidContract() {
        if (schemaVersion == null || schemaVersion != SCHEMA_VERSION
                || !"landmark.chunk".equals(type)
                || streamId == null
                || sequence == null || sequence < 0
                || frames == null || frames.size() != FRAMES_PER_CHUNK) {
            return false;
        }

        Long previousSequence = null;
        Double previousTimestamp = null;
        for (Frame frame : frames) {
            if (frame == null || !frame.hasValidContract()) {
                return false;
            }
            if (previousSequence != null && frame.sequence() != previousSequence + 1) {
                return false;
            }
            if (previousTimestamp != null && frame.timestampMs() <= previousTimestamp) {
                return false;
            }
            previousSequence = frame.sequence();
            previousTimestamp = frame.timestampMs();
        }
        return true;
    }

    public static UUID parseCanonicalUuid(String value) {
        if (value == null || !CANONICAL_UUID.matcher(value).matches()) {
            return null;
        }
        return UUID.fromString(value);
    }

    @Override
    public String toString() {
        return "LandmarkChunkEvent[redacted]";
    }

    public record Frame(Long sequence, Double timestampMs, List<Double> features) {

        public boolean hasValidContract() {
            if (sequence == null || sequence < 0
                    || timestampMs == null || !Double.isFinite(timestampMs) || timestampMs < 0
                    || features == null || features.size() != FEATURES_PER_FRAME) {
                return false;
            }
            for (int index = 0; index < features.size(); index++) {
                Double feature = features.get(index);
                if (feature == null || !Double.isFinite(feature) || !Float.isFinite(feature.floatValue())) {
                    return false;
                }
                if ((index + 1) % 4 != 0
                        && Math.abs(feature) > MAX_ABSOLUTE_NORMALIZED_COORDINATE) {
                    return false;
                }
                if ((index + 1) % 4 == 0) {
                    if (feature != 0.0 && feature != 1.0) {
                        return false;
                    }
                }
            }
            return true;
        }

        @Override
        public String toString() {
            return "Frame[redacted]";
        }
    }

    public static final class CanonicalUuidDeserializer extends JsonDeserializer<UUID> {

        @Override
        public UUID deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            if (!parser.hasToken(JsonToken.VALUE_STRING)) {
                return (UUID) context.handleUnexpectedToken(UUID.class, parser);
            }
            UUID value = parseCanonicalUuid(parser.getText());
            if (value == null) {
                throw MismatchedInputException.from(
                        parser,
                        UUID.class,
                        "Identifier must use canonical UUID text");
            }
            return value;
        }
    }
}
