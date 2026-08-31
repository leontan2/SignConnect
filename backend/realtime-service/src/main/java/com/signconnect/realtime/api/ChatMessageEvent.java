package com.signconnect.realtime.api;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import java.util.UUID;

public record ChatMessageEvent(
        Integer schemaVersion,
        String type,
        @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID messageId,
        String text) {

    public static final int MAX_TEXT_CODE_POINTS = 500;

    public boolean hasValidContract() {
        if (schemaVersion == null
                || schemaVersion != LandmarkChunkEvent.SCHEMA_VERSION
                || !"chat.message".equals(type)
                || messageId == null
                || text == null) {
            return false;
        }
        String normalized = normalizedText();
        return !normalized.isBlank()
                && normalized.codePointCount(0, normalized.length()) <= MAX_TEXT_CODE_POINTS
                && normalized.codePoints().allMatch(codePoint -> codePoint == '\n'
                        || codePoint == '\t'
                        || codePoint >= 0x20);
    }

    public String normalizedText() {
        return text == null ? "" : text.strip();
    }
}
