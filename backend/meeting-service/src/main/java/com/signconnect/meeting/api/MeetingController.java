package com.signconnect.meeting.api;

import com.signconnect.meeting.application.MeetingAccessService;
import com.signconnect.meeting.application.MeetingNotFoundException;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/meetings")
@CrossOrigin(origins = {
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001"
})
public class MeetingController {

    private final MeetingAccessService meetingAccessService;

    public MeetingController(MeetingAccessService meetingAccessService) {
        this.meetingAccessService = meetingAccessService;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public MeetingSessionResponse create(@Valid @RequestBody CreateMeetingRequest request) {
        return MeetingSessionResponse.from(meetingAccessService.create(
                request.title().trim(),
                request.displayName()));
    }

    @PostMapping("/{joinCode}/participants")
    @ResponseStatus(HttpStatus.CREATED)
    public MeetingSessionResponse join(
            @PathVariable String joinCode,
            @Valid @RequestBody JoinMeetingRequest request) {
        return MeetingSessionResponse.from(meetingAccessService.join(joinCode, request.displayName()));
    }

    @GetMapping("/{meetingId}")
    public MeetingResponse get(@PathVariable java.util.UUID meetingId) {
        return MeetingResponse.from(meetingAccessService.get(meetingId));
    }

    @ExceptionHandler(MeetingNotFoundException.class)
    public ResponseEntity<Void> notFound() {
        return ResponseEntity.notFound().build();
    }
}
