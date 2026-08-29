package com.signconnect.meeting;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

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
                .andExpect(jsonPath("$.id").isString())
                .andExpect(jsonPath("$.title").value("Accessibility standup"))
                .andExpect(jsonPath("$.status").value("READY"));
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
}
