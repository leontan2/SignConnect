package com.signconnect.meeting.api;

import com.signconnect.meeting.application.MeetingRegistry;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/meetings")
@CrossOrigin(origins = {"http://localhost:3000", "http://localhost:3001"})
public class MeetingController {

    private final MeetingRegistry meetingRegistry;

    public MeetingController(MeetingRegistry meetingRegistry) {
        this.meetingRegistry = meetingRegistry;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public MeetingResponse create(@Valid @RequestBody CreateMeetingRequest request) {
        return MeetingResponse.from(meetingRegistry.create(request.title().trim()));
    }
}