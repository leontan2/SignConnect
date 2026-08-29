package com.signconnect.meeting;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class MeetingApiTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void createsMeetingReadyForParticipants() throws Exception {
        mockMvc.perform(post("/api/v1/meetings")
                        .header("Origin", "http://localhost:3000")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "title": "Accessibility standup"
                                }
                                """))
                .andExpect(status().isCreated())
                .andExpect(header().string("Access-Control-Allow-Origin", "http://localhost:3000"))
                .andExpect(jsonPath("$.meeting.id").isString())
                .andExpect(jsonPath("$.meeting.joinCode").isString())
                .andExpect(jsonPath("$.meeting.title").value("Accessibility standup"))
                .andExpect(jsonPath("$.meeting.status").value("READY"))
                .andExpect(jsonPath("$.participant.id").isString())
                .andExpect(jsonPath("$.participant.displayName").value("Host"))
                .andExpect(jsonPath("$.participant.role").value("HOST"))
                .andExpect(jsonPath("$.realtimeTicket").isString())
                .andExpect(jsonPath("$.realtimeTicketExpiresAt").isString());
    }

    @Test
    void allowsTheLoopbackOriginUsedByTheFullStackRunner() throws Exception {
        mockMvc.perform(post("/api/v1/meetings")
                        .header("Origin", "http://127.0.0.1:3000")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "title": "Loopback validation"
                                }
                                """))
                .andExpect(status().isCreated())
                .andExpect(header().string("Access-Control-Allow-Origin", "http://127.0.0.1:3000"));
    }

    @Test
    void letsAGuestJoinWithTheShareCodeAndReadMeetingMetadata() throws Exception {
        MvcResult created = mockMvc.perform(post("/api/v1/meetings")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "title": "Room join validation",
                                  "displayName": "Leon"
                                }
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.participant.displayName").value("Leon"))
                .andReturn();

        String response = created.getResponse().getContentAsString();
        String joinCode = com.jayway.jsonpath.JsonPath.read(response, "$.meeting.joinCode");
        String meetingId = com.jayway.jsonpath.JsonPath.read(response, "$.meeting.id");

        mockMvc.perform(post("/api/v1/meetings/{joinCode}/participants", joinCode.toLowerCase())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "displayName": "Ari"
                                }
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.meeting.id").value(meetingId))
                .andExpect(jsonPath("$.meeting.joinCode").value(joinCode))
                .andExpect(jsonPath("$.participant.displayName").value("Ari"))
                .andExpect(jsonPath("$.participant.role").value("GUEST"))
                .andExpect(jsonPath("$.realtimeTicket").isString());

        mockMvc.perform(get("/api/v1/meetings/{meetingId}", meetingId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(meetingId))
                .andExpect(jsonPath("$.joinCode").value(joinCode));
    }

    @Test
    void returnsNotFoundForUnknownJoinCode() throws Exception {
        mockMvc.perform(post("/api/v1/meetings/ABC234/participants")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {
                                  "displayName": "Guest"
                                }
                                """))
                .andExpect(status().isNotFound());
    }
}
