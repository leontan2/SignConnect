package com.signconnect.realtime.room;

import com.signconnect.realtime.api.CaptionEvent;

import java.time.Instant;
import java.util.UUID;
import java.util.function.Consumer;

public interface RoomRegistry {

    RoomMembership join(
            RoomParticipant participant,
            Consumer<String> outbound,
            Runnable invalidateConnection,
            String resumeToken,
            Instant resumeExpiresAt);

    RoomMembership resume(
            RoomParticipant participant,
            Consumer<String> outbound,
            Runnable invalidateConnection,
            String presentedResumeToken,
            String rotatedResumeToken,
            Instant resumeExpiresAt);

    void leave(RoomMembership membership);

    void publishCaption(RoomMembership source, CaptionEvent caption);

    void requestSigner(RoomMembership source, UUID requestId, UUID streamId);

    void denySigner(RoomMembership source, UUID requestId, UUID streamId, String reason);

    boolean releaseSigner(RoomMembership source, UUID streamId, String reason);

    boolean ownsSigner(RoomMembership source, UUID streamId);

    final class RoomCapacityExceededException extends RuntimeException {
        public RoomCapacityExceededException() {
            super("Room participant capacity was reached");
        }
    }

    final class ParticipantAlreadyConnectedException extends RuntimeException {
        public ParticipantAlreadyConnectedException() {
            super("Participant already has an active connection");
        }
    }

    final class RoomNotFoundException extends RuntimeException {
        public RoomNotFoundException() {
            super("Room does not exist");
        }
    }

    final class InvalidResumeTokenException extends RuntimeException {
        public InvalidResumeTokenException() {
            super("Resume token is no longer current");
        }
    }
}
