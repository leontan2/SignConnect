package com.signconnect.realtime.api;

public record CaptionPayload(
        String text,
        double confidence
) {
}