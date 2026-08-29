package com.signconnect.realtime.api;

public record RoomJoinEvent(
        int schemaVersion,
        String type,
        String ticket
) {
    public static final int SCHEMA_VERSION = 1;

    public boolean hasValidContract() {
        return schemaVersion == SCHEMA_VERSION
                && "room.join".equals(type)
                && ticket != null
                && !ticket.isBlank()
                && ticket.length() <= 2048;
    }
}
