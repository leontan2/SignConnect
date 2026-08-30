# Sign-recognition v1 contracts

The JSON Schemas in this directory are the canonical contracts for recognition inputs, inference results, server feedback, and the browser-local `BrowserLocalVisionFrame` snapshot.

`tracking-feedback.schema.json` describes exactly the snapshot passed from the vision worker into local capture and UI state. Its overlay `x`, `y`, and optional `confidence` values are allowed solely to render the local guide. The snapshot must never be sent over WebSocket or HTTP, published to a room, logged, persisted, or added to transcript content. `caption.final` remains the only public recognition caption event.

The snapshot keeps raw tracking facts, calibration, and gesture phase separate from the final 13-state application mapper. Tracking quality uses this precedence:

1. `no-person`
2. `upper-body-missing`
3. `left-hand-missing`
4. `right-hand-missing`
5. `out-of-frame`
6. `low-quality`
7. `ready`

The schema verifies the boolean facts needed for states 1 through 5. Both `low-quality` and `ready` have all visibility facts set because the confidence threshold used to distinguish them is intentionally not part of `BrowserLocalTrackingQualityFacts`.

This browser-local schema is additive. It does not change the existing landmark, inference, or server-event wire objects.
