package com.signconnect.realtime.room;

import com.signconnect.realtime.api.CaptionEvent;

import java.util.function.Consumer;

public interface RoomRegistry {

    RoomMembership join(RoomParticipant participant, Consumer<String> outbound);

    void leave(RoomMembership membership);

    void publishCaption(RoomMembership source, CaptionEvent caption);

    final class RoomCapacityExceededException extends RuntimeException {
        public RoomCapacityExceededException() {
            super("Room participant capacity was reached");
        }
    }
}
