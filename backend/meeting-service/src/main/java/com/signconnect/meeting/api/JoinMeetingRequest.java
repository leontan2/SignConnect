package com.signconnect.meeting.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record JoinMeetingRequest(
        @NotBlank @Size(max = 50) String displayName
) {
}
