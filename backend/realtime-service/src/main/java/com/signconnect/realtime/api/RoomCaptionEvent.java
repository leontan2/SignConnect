package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record RoomCaptionEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID participantId,
        UUID captionId,
        UUID streamId,
        long sequence,
        Payload payload,
        Instant occurredAt
) {
    public record Payload(
            String labelId,
            String text,
            double confidence,
            String modelVersion,
            double inferenceLatencyMs,
            boolean mockModel,
            String sourceDisplayName
    ) {
        public static Payload from(CaptionPayload caption, String sourceDisplayName) {
            return new Payload(
                    caption.labelId(),
                    caption.text(),
                    caption.confidence(),
                    caption.modelVersion(),
                    caption.inferenceLatencyMs(),
                    caption.mockModel(),
                    sourceDisplayName);
        }
    }
}
