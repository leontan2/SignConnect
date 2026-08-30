package com.signconnect.realtime.api;

public record RoomJoinEvent(
        int schemaVersion,
        String type,
        String ticket,
        String resumeToken
) {
    public static final int SCHEMA_VERSION = 1;

    public boolean hasValidContract() {
        return schemaVersion == SCHEMA_VERSION
                && "room.join".equals(type)
                && (ticket == null) != (resumeToken == null)
                && (validCredential(ticket) || validCredential(resumeToken));
    }

    public String credential() {
        return validCredential(ticket) ? ticket : resumeToken;
    }

    public boolean isResume() {
        return validCredential(resumeToken);
    }

    private static boolean validCredential(String value) {
        return value != null && !value.isBlank() && value.length() <= 2048;
    }
}
