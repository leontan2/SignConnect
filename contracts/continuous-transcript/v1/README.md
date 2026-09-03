# Continuous transcript event contract v1

This proposed contract defines the revision lifecycle for bounded continuous signed contributions. It does not authorize continuous SgSL capture, model training, or production emission.

Public room events are `transcript.partial`, `transcript.revised`, `transcript.final`, and `transcript.cancelled`. They use a stable `contributionId`, a monotonically increasing `revision`, and the room's ordered `sequence`. `transcript.uncertain` is private signer feedback and deliberately carries no speculative text.

The schema forbids undeclared properties, including raw frames, landmarks, embeddings, logits, gloss tokens, prompts, and hidden model output. Transition rules that JSON Schema cannot express are mirrored by the pure guards in `frontend/apps/meeting/src/continuousTranscript.ts` and `backend/realtime-service/src/main/java/com/signconnect/realtime/transcript/TranscriptRevisionGuard.java`, with focused tests on both runtimes.

The contract and both guards remain disconnected from the production realtime path while ADR-0004 is proposed. Production emission remains disabled.
