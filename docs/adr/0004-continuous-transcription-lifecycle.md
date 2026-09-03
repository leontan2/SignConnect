# ADR-0004: Define a revision-safe continuous transcription lifecycle

**Date**: 2026-09-03
**Status**: proposed; implementation and data collection remain gated by Deaf-led co-design, privacy review, and project-owner approval
**Deciders**: SignConnect product, engineering, privacy, and SgSL co-design partners

## Context

The current meeting path publishes immutable `caption.final` events for isolated supported signs. The browser groups those captions into a provisional sentence card, but the recognizer cannot revise text, represent a continuous signed contribution, or distinguish a provisional translation from a final transcript entry.

Continuous Singapore Sign Language (SgSL) transcription changes the capture, inference, realtime, accessibility, privacy, and evaluation contracts. A late or duplicated revision must not overwrite newer text, provisional text must never look final, and uncertain recognition must not invent public transcript content. Raw video currently stays in the browser and that boundary must not drift accidentally while the research representation is still under review.

## Proposed decision

### Representation

The public realtime contract carries reviewed display text, not raw frames, landmarks, embeddings, logits, gloss sequences, or model prompts. Each event records whether the producing pipeline used direct text or a gloss-to-text stage, together with versioned model and representation identifiers. The internal representation and final SgSL language identifier remain subject to Deaf-led linguistic review; this ADR does not approve either one.

One signed contribution has a stable `contributionId`. Revisions are zero-based non-negative integers and increase monotonically within the same participant and recognition stream. A contribution may move through:

1. `transcript.partial` at revision `0`;
2. zero or more `transcript.revised` events with higher revisions;
3. exactly one terminal `transcript.final` or `transcript.cancelled` event with a higher revision.

A model may emit `transcript.final` directly at revision `0` when it has never exposed provisional text. `transcript.revised` and `transcript.cancelled` cannot create a contribution.

### Capture and inference

Continuous capture will use a new contract rather than stretching the isolated `[1,30,224]` window. The future contract must declare sequence duration, sample timing, feature groups, masks, normalization, model input version, and contribution boundaries. Raw video remains browser-local.

Hand and upper-body landmarks may remain eligible inputs. Facial expression, head movement, mouthing, or any other non-manual feature group is disabled until SgSL co-design identifies what is necessary and an updated privacy notice, consent boundary, minimization review, and retention decision are approved. No continuous human-subject capture is authorized by this proposal.

### Realtime lifecycle

- `transcript.partial`, `transcript.revised`, `transcript.final`, and `transcript.cancelled` are ordered public room events. Every participant receives the same event with the same room sequence.
- `transcript.uncertain` is private signer feedback. It contains a bounded reason and safe message but no speculative transcript text.
- The server rejects a revision that is older than or equal to the accepted revision, except for an exact replay of the same event, which is idempotent.
- A conflicting replay at the same revision, a participant or stream change for an existing contribution, and every event after a terminal revision fail closed.
- Clients apply the same revision checks. Only `transcript.final` enters finalized transcript history; partial and revised text stays visibly provisional.
- Cancellation removes provisional text from the public presentation and retains no transcript text. A cancellation reason may be shown as status, not as signed content.

### Reconnect and backpressure

A reconnect snapshot must eventually include the latest non-terminal contribution revision or explicitly cancel it before new revisions are accepted. Until that snapshot extension exists, production emission remains disabled.

Backpressure may coalesce intermediate partial or revised events for the same contribution, but it must preserve increasing revisions and may never drop, reorder, or replace a final or cancelled event. Clients therefore accept a higher revision without requiring every intermediate number.

### Latency and accessibility

Initial engineering budgets are: first provisional text within 1.5 seconds of a detectable contribution, revisions no more often than every 300 ms, and terminal text within 2 seconds of a contribution boundary. These are research targets, not acceptance evidence.

The interface must distinguish provisional from final text visually and programmatically. Accessibility announcements should debounce provisional changes and announce the final contribution once; rapid revisions must not flood a live region. Typed fallback, video, and audio remain usable during model delay, uncertainty, cancellation, or failure.

### Privacy and retention

Only bounded text plus attribution, confidence, timing, model, and representation provenance may enter the room event. No media-derived feature, raw model output, prompt, or hidden token sequence may be logged, persisted, replayed, or broadcast by this contract.

Transcripts remain ephemeral by default. Persistence, analytics, training reuse, and continuous capture require separate explicit decisions and consent. Live meeting consent never authorizes training-data collection.

## Failure semantics

- Low confidence, out-of-domain signing, invalid capture, and model unavailability produce private `transcript.uncertain` feedback and no public text.
- A contribution that became provisional but cannot be completed emits `transcript.cancelled`.
- Stale, conflicting, identity-mismatched, and post-terminal revisions are ignored and recorded only as metadata-safe protocol diagnostics.
- A transcript failure cannot stop or degrade the call, chat, or typed fallback path.

## Rollout gates

This proposal may become accepted only after:

- SgSL-fluent Deaf reviewers approve the bounded domain, representation, wording, non-manual requirements, and uncertainty behavior;
- privacy and product owners approve feature minimization, consent, retention, and transcript defaults;
- the continuous capture/inference schema and reconnect snapshot design are reviewed;
- server and client tests prove ordering, idempotency, stale-revision rejection, terminal behavior, cancellation, and private uncertainty;
- an accessibility review approves provisional/final presentation and announcement behavior.

Until those gates pass, the repository may contain contract fixtures and pure lifecycle guards, but the realtime service must not emit continuous transcript events and the product must not claim continuous SgSL transcription.

## Consequences

### Positive

- Provisional text cannot silently masquerade as final history.
- Server and client convergence has explicit idempotency and stale-revision rules.
- Uncertain signing fails privately without fabricating public text.
- The raw-video and training-consent boundaries remain intact while research continues.

### Negative

- Reconnect snapshots and backpressure need additional state beyond immutable captions.
- Revisions increase UI and accessibility complexity.
- The contract cannot be enabled until external linguistic, data, privacy, and evaluation gates clear.

## Alternatives considered

### Continue composing immutable isolated-sign captions

This remains the safe current product bridge, but it cannot revise model output or represent genuine continuous SgSL grammar.

### Publish gloss tokens to the room

Glosses can aid model debugging but are not user-ready translations and may expose unstable intermediate output. Keep them browser/model-local unless a later reviewed decision explicitly permits them.

### Replace text in place without revisions

This is simpler, but reconnects, duplicates, delayed messages, and assistive announcements cannot determine which value is authoritative. Stable contribution and revision IDs are required.
