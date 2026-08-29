package com.signconnect.inference;

import com.signconnect.inference.config.InferenceLimitsProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

@SpringBootApplication
@EnableConfigurationProperties(InferenceLimitsProperties.class)
public class SignInferenceServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(SignInferenceServiceApplication.class, args);
    }
}
