package com.signconnect.realtime.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

@ConfigurationProperties(prefix = "signconnect.rooms")
public class RoomProperties {

    private String ticketSecret;
    private int maxParticipants = 8;
    private boolean requireJoin = true;
    private Duration resumeTicketTtl = Duration.ofMinutes(5);

    public String getTicketSecret() {
        return ticketSecret;
    }

    public void setTicketSecret(String ticketSecret) {
        this.ticketSecret = ticketSecret;
    }

    public int getMaxParticipants() {
        return maxParticipants;
    }

    public void setMaxParticipants(int maxParticipants) {
        this.maxParticipants = maxParticipants;
    }

    public boolean isRequireJoin() {
        return requireJoin;
    }

    public void setRequireJoin(boolean requireJoin) {
        this.requireJoin = requireJoin;
    }

    public Duration getResumeTicketTtl() {
        return resumeTicketTtl;
    }

    public void setResumeTicketTtl(Duration resumeTicketTtl) {
        this.resumeTicketTtl = resumeTicketTtl;
    }
}
