package com.signconnect.realtimecontract;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.Objects;
import java.util.UUID;

public final class RealtimeTicketCodec {

    private static final String ALGORITHM = "HmacSHA256";
    private static final String VERSION = "1";
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();

    private final byte[] secret;
    private final Clock clock;

    public RealtimeTicketCodec(String secret, Clock clock) {
        if (secret == null || secret.length() < 32) {
            throw new IllegalArgumentException("Realtime ticket secret must contain at least 32 characters");
        }
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    public String issue(Claims claims) {
        validateClaims(claims);
        String displayName = ENCODER.encodeToString(claims.displayName().getBytes(StandardCharsets.UTF_8));
        String payload = String.join("|",
                VERSION,
                claims.meetingId().toString(),
                claims.participantId().toString(),
                claims.role(),
                Long.toString(claims.expiresAt().getEpochSecond()),
                displayName);
        byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
        return ENCODER.encodeToString(payloadBytes) + "." + ENCODER.encodeToString(sign(payloadBytes));
    }

    public Claims verify(String token) {
        try {
            if (token == null || token.isBlank() || token.length() > 2048) {
                throw invalid();
            }
            String[] tokenParts = token.split("\\.", -1);
            if (tokenParts.length != 2) {
                throw invalid();
            }
            byte[] payloadBytes = DECODER.decode(tokenParts[0]);
            byte[] suppliedSignature = DECODER.decode(tokenParts[1]);
            if (!MessageDigest.isEqual(sign(payloadBytes), suppliedSignature)) {
                throw invalid();
            }

            String[] claimsParts = new String(payloadBytes, StandardCharsets.UTF_8).split("\\|", -1);
            if (claimsParts.length != 6 || !VERSION.equals(claimsParts[0])) {
                throw invalid();
            }
            Claims claims = new Claims(
                    UUID.fromString(claimsParts[1]),
                    UUID.fromString(claimsParts[2]),
                    new String(DECODER.decode(claimsParts[5]), StandardCharsets.UTF_8),
                    claimsParts[3],
                    Instant.ofEpochSecond(Long.parseLong(claimsParts[4])));
            validateClaims(claims);
            if (!claims.expiresAt().isAfter(clock.instant())) {
                throw new InvalidTicketException("Realtime ticket has expired");
            }
            return claims;
        } catch (InvalidTicketException exception) {
            throw exception;
        } catch (IllegalArgumentException exception) {
            throw invalid();
        }
    }

    private byte[] sign(byte[] payload) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(secret, ALGORITHM));
            return mac.doFinal(payload);
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException("Could not initialize realtime ticket signing", exception);
        }
    }

    private static void validateClaims(Claims claims) {
        Objects.requireNonNull(claims, "claims");
        Objects.requireNonNull(claims.meetingId(), "meetingId");
        Objects.requireNonNull(claims.participantId(), "participantId");
        Objects.requireNonNull(claims.expiresAt(), "expiresAt");
        if (claims.displayName() == null
                || claims.displayName().isBlank()
                || claims.displayName().length() > 50) {
            throw new IllegalArgumentException("Display name must contain 1 to 50 characters");
        }
        if (!"HOST".equals(claims.role()) && !"GUEST".equals(claims.role())) {
            throw new IllegalArgumentException("Unsupported participant role");
        }
    }

    private static InvalidTicketException invalid() {
        return new InvalidTicketException("Realtime ticket is invalid");
    }

    public record Claims(
            UUID meetingId,
            UUID participantId,
            String displayName,
            String role,
            Instant expiresAt) {
    }

    public static final class InvalidTicketException extends IllegalArgumentException {
        public InvalidTicketException(String message) {
            super(message);
        }
    }
}
