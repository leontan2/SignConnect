package com.signconnect.realtime.api;

import java.time.Instant;
import java.util.UUID;

public record CaptionEvent(
        int schemaVersion,
        String type,
        UUID meetingId,
        UUID streamId,
        long sequence,
        CaptionPayload payload,
        Instant occurredAt
) {
}
