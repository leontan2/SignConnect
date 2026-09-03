package com.signconnect.realtime.transcript;

import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Proposed continuous-transcript v1 public event value.
 *
 * <p>This type is deliberately disconnected from the WebSocket and room
 * registry paths while ADR-0004 remains proposed.</p>
 */
public record PublicTranscriptEvent(
        int schemaVersion,
        int transcriptVersion,
        Type type,
        UUID meetingId,
        UUID participantId,
        UUID streamId,
        UUID contributionId,
        long revision,
        long sequence,
        Payload payload,
        Instant occurredAt) {

    private static final Pattern VERSION_IDENTIFIER =
            Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]*$");

    public enum Type {
        PARTIAL("transcript.partial", false, false),
        REVISED("transcript.revised", false, false),
        FINAL("transcript.final", true, false),
        CANCELLED("transcript.cancelled", true, true);

        private final String wireName;
        private final boolean terminal;
        private final boolean cancellation;

        Type(String wireName, boolean terminal, boolean cancellation) {
            this.wireName = wireName;
            this.terminal = terminal;
            this.cancellation = cancellation;
        }

        public String wireName() {
            return wireName;
        }

        public boolean terminal() {
            return terminal;
        }

        public boolean cancellation() {
            return cancellation;
        }
    }

    public sealed interface Payload permits TextPayload, CancelledPayload {
    }

    public record TextPayload(
            String text,
            double confidence,
            String modelVersion,
            Representation representation,
            String representationVersion,
            String sourceDisplayName) implements Payload {
    }

    public record CancelledPayload(
            CancellationReason reason,
            String sourceDisplayName) implements Payload {
    }

    public enum Representation {
        DIRECT_TEXT("direct_text"),
        GLOSS_TO_TEXT("gloss_to_text");

        private final String wireName;

        Representation(String wireName) {
            this.wireName = wireName;
        }

        public String wireName() {
            return wireName;
        }
    }

    public enum CancellationReason {
        UNCERTAIN,
        OUT_OF_DOMAIN,
        CAPTURE_INVALID,
        MODEL_UNAVAILABLE,
        SIGNER_STOPPED,
        SUPERSEDED
    }

    public boolean hasValidContract() {
        if (schemaVersion != 1
                || transcriptVersion != 1
                || type == null
                || meetingId == null
                || participantId == null
                || streamId == null
                || contributionId == null
                || revision < 0
                || sequence < 1
                || occurredAt == null) {
            return false;
        }
        if (type.cancellation()) {
            return revision >= 1
                    && payload instanceof CancelledPayload cancelled
                    && cancelled.reason() != null
                    && validLength(cancelled.sourceDisplayName(), 1, 50);
        }
        return payload instanceof TextPayload textPayload
                && validText(textPayload.text())
                && Double.isFinite(textPayload.confidence())
                && textPayload.confidence() >= 0
                && textPayload.confidence() <= 1
                && validVersionIdentifier(textPayload.modelVersion())
                && textPayload.representation() != null
                && validVersionIdentifier(textPayload.representationVersion())
                && validLength(textPayload.sourceDisplayName(), 1, 50);
    }

    private static boolean validText(String value) {
        if (!validLength(value, 1, 500) || value.isBlank()) {
            return false;
        }
        return value.codePoints().noneMatch(codePoint ->
                (codePoint >= 0x00 && codePoint <= 0x08)
                        || codePoint == 0x0B
                        || codePoint == 0x0C
                        || (codePoint >= 0x0E && codePoint <= 0x1F)
                        || codePoint == 0x7F);
    }

    private static boolean validVersionIdentifier(String value) {
        return validLength(value, 1, 64) && VERSION_IDENTIFIER.matcher(value).matches();
    }

    private static boolean validLength(String value, int minimum, int maximum) {
        if (value == null) {
            return false;
        }
        int length = value.codePointCount(0, value.length());
        return length >= minimum && length <= maximum;
    }
}
