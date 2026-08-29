# ADR-0002: Add authenticated ephemeral rooms around private recognition sessions

## Status

Accepted for Milestone 1.

## Context

The mock-first recognition path in ADR-0001 intentionally returns captions only to the WebSocket connection that submitted landmarks. A usable two-person product demonstration needs shared participant presence and shared finalized captions without changing the ownership or privacy behavior of landmark capture, rolling windows, stabilization, or inference.

The meeting and realtime services are independent processes and the first room milestone does not introduce a database, Redis, or a synchronous service-to-service authorization call.

## Decision

The meeting service issues a short-lived HMAC-SHA-256 realtime ticket containing the meeting ID, participant ID, display name, role, and expiry. Both services use the same deployment secret through the `realtime-contract` module. A WebSocket connection must send `room.join` with this ticket before any recognition event is accepted.

The realtime service maintains an in-memory `RoomRegistry`. Each joined socket retains its own `RealtimeRecognitionSession`; landmark chunks, rolling windows, recognition statuses, and unknown-sign feedback are not published through the registry. When a private recognition session emits `caption.final`, the handler wraps it with a room sequence, caption ID, source participant ID, and source display name, then broadcasts that public event to every connection in the same meeting.

The room also publishes a membership snapshot and participant join/leave events. The default room capacity is eight connections.

## Consequences

- Two browsers can join the same room and render the same finalized caption.
- Recognition internals remain isolated by WebSocket connection.
- No persistence or external broker is required for the first demonstration.
- Room state disappears when the realtime service restarts.
- Tickets expire after four hours by default and become invalid if the shared secret changes.
- A later Redis implementation can replace `InMemoryRoomRegistry` without changing the recognition session.
- Reconnect resumption, active-signer arbitration, history replay, and durable identity remain Milestone 2 work.

## Operational requirement

`SIGNCONNECT_REALTIME_TICKET_SECRET` must have the same value in the meeting and realtime services. The repository default exists only to keep local development runnable; deployed environments must override it.
