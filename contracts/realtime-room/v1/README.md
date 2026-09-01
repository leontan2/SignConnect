# Realtime room v1 contracts

These JSON Schemas are the canonical wire contracts for an authenticated, ephemeral SignConnect room. Version 1 remains additive: new event types may be introduced beside existing types, but existing event fields and meanings must not change without explicit version negotiation or a new protocol version.

## Client commands

- `room-join.schema.json` authenticates an initial or resumed connection.
- `signer-request.schema.json` and `signer-release.schema.json` control the room's single active-signer lease.
- `chat-message.schema.json` submits one immutable typed transcript entry. The server supplies source identity, room order, and occurrence time.
- `call-signal.schema.json` carries WebRTC offers, answers, ICE candidates, call lifecycle reasons, and synchronized media state. The server supplies source identity and routes each command only to `targetParticipantId` in the same room.

Raw camera frames, audio, landmarks, recognition diagnostics, resume credentials, and training data are invalid in typed-message and call-signaling payloads.

## Server events and ordering

`server-event.schema.json` defines public room broadcasts, private replies, and target-private call events:

- Presence, active-signer changes, finalized captions, and typed messages consume a strictly increasing public room sequence. Every connected participant receives the same public event with the same sequence.
- Join replies, snapshots, signer denials, and target-private call signals carry the latest public sequence as a baseline. They do not consume public room order.
- Room errors are connection-private diagnostics and do not consume public room order.

Call signaling is transient and is not replayed after reconnect. Stable `signalId`, `messageId`, and `captionId` values provide bounded duplicate protection at their respective boundaries.

Fixtures under `fixtures/` are validated by the Meeting frontend contract suite. Runtime Java and browser parsers must remain at least as strict as these schemas.
