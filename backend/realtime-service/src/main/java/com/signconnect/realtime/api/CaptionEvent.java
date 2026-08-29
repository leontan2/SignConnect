package com.signconnect.realtime.api;

import java.time.Instant;

public record CaptionEvent(
        String type,
        String meetingId,
        long sequence,
        CaptionPayload payload,
        Instant occurredAt
) {
}