package com.signconnect.meeting.config;

import com.signconnect.realtimecontract.RealtimeTicketCodec;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Clock;

@Configuration
@EnableConfigurationProperties(RealtimeAccessProperties.class)
public class RealtimeAccessConfiguration {

    @Bean
    public Clock meetingClock() {
        return Clock.systemUTC();
    }

    @Bean
    public RealtimeTicketCodec realtimeTicketCodec(RealtimeAccessProperties properties, Clock clock) {
        return new RealtimeTicketCodec(properties.getTicketSecret(), clock);
    }
}
