package com.signconnect.inference.api;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

public record PredictionRequest(
        @NotNull @Min(1) @Max(1) Integer schemaVersion,
        @NotNull @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID requestId,
        @NotNull @JsonDeserialize(using = CanonicalUuidDeserializer.class) UUID streamId,
        @NotNull @Min(0) Long windowSequence,
        @NotNull @Size(min = 30, max = 30) List<@NotNull @Valid Frame> frames) {

    public static final int FRAME_COUNT = 30;
    public static final int FEATURE_COUNT = 224;
    private static final double MAX_ABSOLUTE_NORMALIZED_COORDINATE = 20.0;
    private static final Pattern CANONICAL_UUID = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    @AssertTrue(message = "frame ordering is invalid")
    public boolean isFrameOrderingValid() {
        if (frames == null || frames.size() != FRAME_COUNT) {
            return true;
        }
        Long previousSequence = null;
        Double previousTimestamp = null;
        for (Frame frame : frames) {
            if (frame == null || frame.sequence == null || frame.timestampMs == null) {
                return true;
            }
            if (!Double.isFinite(frame.timestampMs)
                    || (previousSequence != null && frame.sequence <= previousSequence)
                    || (previousTimestamp != null && frame.timestampMs <= previousTimestamp)) {
                return false;
            }
            previousSequence = frame.sequence;
            previousTimestamp = frame.timestampMs;
        }
        return true;
    }

    public boolean hasValidInferenceContract() {
        if (schemaVersion == null || schemaVersion != 1
                || requestId == null || streamId == null
                || windowSequence == null || windowSequence < 0
                || frames == null || frames.size() != FRAME_COUNT
                || !isFrameOrderingValid()) {
            return false;
        }
        return frames.stream().allMatch(frame -> frame != null && frame.hasValidInferenceContract());
    }

    public float[] toFloatTensor() {
        if (!hasValidInferenceContract()) {
            throw new IllegalArgumentException("Request does not match inference contract");
        }
        float[] tensor = new float[FRAME_COUNT * FEATURE_COUNT];
        int offset = 0;
        for (Frame frame : frames) {
            for (Double feature : frame.features) {
                tensor[offset++] = feature.floatValue();
            }
        }
        return tensor;
    }

    @Override
    public String toString() {
        return "PredictionRequest[redacted]";
    }

    public record Frame(
            @NotNull @Min(0) Long sequence,
            @NotNull @DecimalMin("0.0") Double timestampMs,
            @NotNull @JsonDeserialize(contentUsing = StrictFeatureValueDeserializer.class)
            List<@NotNull Double> features) {

        @AssertTrue(message = "features do not match the tensor contract")
        public boolean hasValidFeatures() {
            if (features == null || features.size() != FEATURE_COUNT) {
                return false;
            }
            for (int index = 0; index < features.size(); index++) {
                Double feature = features.get(index);
                if (feature == null || !Double.isFinite(feature)
                        || !Float.isFinite(feature.floatValue())) {
                    return false;
                }
                if ((index + 1) % 4 != 0
                        && Math.abs(feature) > MAX_ABSOLUTE_NORMALIZED_COORDINATE) {
                    return false;
                }
                if ((index + 1) % 4 == 0 && feature != 0.0 && feature != 1.0) {
                    return false;
                }
            }
            return true;
        }

        private boolean hasValidInferenceContract() {
            return sequence != null && sequence >= 0
                    && timestampMs != null && Double.isFinite(timestampMs) && timestampMs >= 0
                    && hasValidFeatures();
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
            String value = parser.getText();
            if (!CANONICAL_UUID.matcher(value).matches()) {
                throw MismatchedInputException.from(
                        parser,
                        UUID.class,
                        "Request identifier must use canonical UUID text");
            }
            return UUID.fromString(value);
        }
    }

    public static final class StrictFeatureValueDeserializer extends JsonDeserializer<Double> {

        @Override
        public Double deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            JsonToken token = parser.currentToken();
            if (token != JsonToken.VALUE_NUMBER_INT && token != JsonToken.VALUE_NUMBER_FLOAT) {
                throw safeFeatureMismatch(parser);
            }
            double value;
            try {
                value = parser.getDoubleValue();
            } catch (IOException failure) {
                throw safeFeatureMismatch(parser);
            }
            if (!Double.isFinite(value) || !Float.isFinite((float) value)) {
                throw safeFeatureMismatch(parser);
            }
            return value;
        }

        private static MismatchedInputException safeFeatureMismatch(JsonParser parser) {
            return MismatchedInputException.from(
                    parser,
                    Double.class,
                    "Feature must be a finite JSON number representable as float32");
        }
    }
}
