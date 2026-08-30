package com.signconnect.realtimecontract;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RealtimeTicketCodecTest {

    private static final Instant NOW = Instant.parse("2026-08-29T12:00:00Z");
    private static final String SECRET = "test-signconnect-realtime-ticket-secret";

    @Test
    void roundTripsSignedClaims() {
        RealtimeTicketCodec codec = codec();
        RealtimeTicketCodec.Claims claims = new RealtimeTicketCodec.Claims(
                UUID.fromString("11111111-1111-4111-8111-111111111111"),
                UUID.fromString("22222222-2222-4222-8222-222222222222"),
                "Leon | Host",
                "HOST",
                NOW.plusSeconds(600));

        assertThat(codec.verify(codec.issue(claims))).isEqualTo(claims);
    }

    @Test
    void rejectsTamperedAndExpiredTickets() {
        RealtimeTicketCodec codec = codec();
        RealtimeTicketCodec.Claims expired = new RealtimeTicketCodec.Claims(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "Guest",
                "GUEST",
                NOW.minusSeconds(1));
        String expiredTicket = codec.issue(expired);

        assertThatThrownBy(() -> codec.verify(expiredTicket))
                .isInstanceOf(RealtimeTicketCodec.InvalidTicketException.class)
                .hasMessageContaining("expired")
                .satisfies(error -> assertThat(
                        ((RealtimeTicketCodec.InvalidTicketException) error).reason())
                        .isEqualTo(RealtimeTicketCodec.InvalidTicketException.Reason.EXPIRED));
        assertThatThrownBy(() -> codec.verify(expiredTicket.substring(0, expiredTicket.length() - 1) + "A"))
                .isInstanceOf(RealtimeTicketCodec.InvalidTicketException.class);
    }

    @Test
    void keepsShortLivedResumeCredentialsPurposeBound() {
        RealtimeTicketCodec codec = codec();
        RealtimeTicketCodec.Claims claims = new RealtimeTicketCodec.Claims(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "Returning guest",
                "GUEST",
                NOW.plusSeconds(120));
        String resumeToken = codec.issueResume(claims);
        String rotatedResumeToken = codec.issueResume(claims);

        assertThat(codec.verifyResume(resumeToken)).isEqualTo(claims);
        assertThat(rotatedResumeToken).isNotEqualTo(resumeToken);
        assertThat(codec.verifyResume(rotatedResumeToken)).isEqualTo(claims);
        assertThatThrownBy(() -> codec.verify(resumeToken))
                .isInstanceOf(RealtimeTicketCodec.InvalidTicketException.class);
        assertThatThrownBy(() -> codec.verifyResume(codec.issue(claims)))
                .isInstanceOf(RealtimeTicketCodec.InvalidTicketException.class);
    }

    private static RealtimeTicketCodec codec() {
        return new RealtimeTicketCodec(SECRET, Clock.fixed(NOW, ZoneOffset.UTC));
    }
}
