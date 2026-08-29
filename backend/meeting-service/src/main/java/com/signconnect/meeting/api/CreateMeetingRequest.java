package com.signconnect.meeting.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateMeetingRequest(
        @NotBlank @Size(max = 120) String title,
        @Size(max = 50) String displayName
) {
}
