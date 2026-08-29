package com.signconnect.realtime.config;

import com.signconnect.realtime.web.CaptionWebSocketHandler;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.reactive.handler.SimpleUrlHandlerMapping;
import org.springframework.web.reactive.socket.server.support.HandshakeWebSocketService;
import org.springframework.web.reactive.socket.server.support.WebSocketHandlerAdapter;
import org.springframework.web.reactive.socket.server.upgrade.ReactorNettyRequestUpgradeStrategy;

import java.time.Clock;
import java.util.Map;

@Configuration
@EnableConfigurationProperties(RecognitionProperties.class)
public class WebSocketConfiguration {

    @Bean
    public HandlerMapping webSocketHandlerMapping(CaptionWebSocketHandler handler) {
        SimpleUrlHandlerMapping mapping = new SimpleUrlHandlerMapping();
        mapping.setOrder(-1);
        mapping.setUrlMap(Map.of("/ws/v1/realtime/**", handler));
        return mapping;
    }

    @Bean
    public WebSocketHandlerAdapter webSocketHandlerAdapter(RecognitionProperties properties) {
        ReactorNettyRequestUpgradeStrategy strategy = new ReactorNettyRequestUpgradeStrategy();
        strategy.setMaxFramePayloadLength(properties.hardFramePayloadLimit());
        return new WebSocketHandlerAdapter(new HandshakeWebSocketService(strategy));
    }

    @Bean
    @ConditionalOnMissingBean(Clock.class)
    public Clock recognitionClock() {
        return Clock.systemUTC();
    }
}
