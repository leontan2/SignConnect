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
    private static final String RESUME_VERSION = "3";
    private static final String RESUME_PURPOSE = "RESUME";
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

    public String issueResume(Claims claims) {
        validateClaims(claims);
        String displayName = ENCODER.encodeToString(claims.displayName().getBytes(StandardCharsets.UTF_8));
        String payload = String.join("|",
                RESUME_VERSION,
                RESUME_PURPOSE,
                UUID.randomUUID().toString(),
                claims.meetingId().toString(),
                claims.participantId().toString(),
                claims.role(),
                Long.toString(claims.expiresAt().getEpochSecond()),
                displayName);
        byte[] payloadBytes = payload.getBytes(StandardCharsets.UTF_8);
        return ENCODER.encodeToString(payloadBytes) + "." + ENCODER.encodeToString(sign(payloadBytes));
    }

    public Claims verify(String token) {
        return verify(token, false);
    }

    public Claims verifyResume(String token) {
        return verify(token, true);
    }

    private Claims verify(String token, boolean resume) {
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
            Claims claims = resume ? decodeResumeClaims(claimsParts) : decodeRealtimeClaims(claimsParts);
            validateClaims(claims);
            if (!claims.expiresAt().isAfter(clock.instant())) {
                throw new InvalidTicketException(
                        "Realtime ticket has expired", InvalidTicketException.Reason.EXPIRED);
            }
            return claims;
        } catch (InvalidTicketException exception) {
            throw exception;
        } catch (IllegalArgumentException exception) {
            throw invalid();
        }
    }

    private static Claims decodeRealtimeClaims(String[] parts) {
        if (parts.length != 6 || !VERSION.equals(parts[0])) {
            throw invalid();
        }
        return new Claims(
                UUID.fromString(parts[1]),
                UUID.fromString(parts[2]),
                new String(DECODER.decode(parts[5]), StandardCharsets.UTF_8),
                parts[3],
                Instant.ofEpochSecond(Long.parseLong(parts[4])));
    }

    private static Claims decodeResumeClaims(String[] parts) {
        if (parts.length != 8
                || !RESUME_VERSION.equals(parts[0])
                || !RESUME_PURPOSE.equals(parts[1])) {
            throw invalid();
        }
        UUID.fromString(parts[2]);
        return new Claims(
                UUID.fromString(parts[3]),
                UUID.fromString(parts[4]),
                new String(DECODER.decode(parts[7]), StandardCharsets.UTF_8),
                parts[5],
                Instant.ofEpochSecond(Long.parseLong(parts[6])));
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
        return new InvalidTicketException(
                "Realtime ticket is invalid", InvalidTicketException.Reason.INVALID);
    }

    public record Claims(
            UUID meetingId,
            UUID participantId,
            String displayName,
            String role,
            Instant expiresAt) {
    }

    public static final class InvalidTicketException extends IllegalArgumentException {
        private final Reason reason;

        public InvalidTicketException(String message, Reason reason) {
            super(message);
            this.reason = reason;
        }

        public Reason reason() {
            return reason;
        }

        public enum Reason {
            INVALID,
            EXPIRED
        }
    }
}
