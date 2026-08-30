# SGSL external-input request packet

**Status:** Draft for project-owner, privacy, licence, and SGSL-community review

**Prepared:** 2026-08-30
**Purpose:** Clear SignConnect gate G5 without weakening the genuine-SGSL definition of done

This is an engineering request checklist, not legal advice or permission to collect data. Do not download, copy, label, or train on human-subject material until the project owner records the required approvals.

## Route A — NTU pilot-corpus evidence request

The 2016 NTU pilot corpus is the strongest identified lead, but the reviewed thesis is not an acquisition package. Ask the corpus owner or current institutional custodian to provide or confirm:

- an immutable dataset release location, version, checksums, and current custodian;
- the exact files and annotations covered by the stated CC BY 4.0 consent;
- participant consent terms covering ML training, evaluation, derived landmark storage, model-weight creation, distribution, publication, and the intended commercial or non-commercial use;
- any limits on redistribution, access, geography, retention, model release, or downstream use;
- withdrawal and deletion procedures, including whether a withdrawal invalidates derived datasets or trained weights;
- pseudonymous signer identifiers sufficient for immutable train, validation, and final-test separation;
- whether the recordings contain the proposed isolated signs, acceptable variants, negative motion, and enough repetitions for a five-sign proof; and
- permission to derive SignConnect's local `[30,224]` representation without publishing raw media.

Do not treat a downloadable URL, a CC badge, or the thesis statement alone as proof that all required rights and consent remain valid for this use.

## Route B — SADeaf and Deaf-community co-design request

Request a compensated SGSL-fluent Deaf reviewer or community partner to review:

- the proposed five concepts and whether each is suitable as an isolated supported sign;
- accepted regional, generational, handedness, and non-manual variants;
- gloss IDs, English caption wording, and unsupported ambiguity;
- collection prompts, examples, exclusion rules, and signer guidance;
- whether the current MediaPipe hands-and-upper-body feature set captures the distinctions needed;
- failure cases and confusion pairs before model promotion; and
- the final browser demonstration and limitations statement.

Separately request written permission before using any Sign Bank media, descriptions, or derived representation for training. Public viewing is not training permission.

## Route C — governed local collection fallback

If Route A cannot provide complete evidence, use ADR-0003's separate collection boundary. Before capture, the project owner must approve:

- named data controller, privacy reviewer, collection operator, and access list;
- participant information and explicit consent for every intended data and model use;
- compensation, recruitment, accessibility, inclusion, and withdrawal procedures;
- raw-media and landmark retention periods, encryption, backup, export, and deletion controls;
- immutable pseudonymous signer assignment and signer-disjoint split policy;
- separate samples for supported signs, `NO_SIGN`, idle, transitions, incomplete gestures, unknown signs, and camera/tracking failures;
- a prohibition on reusing live SignConnect meetings as training capture; and
- the release policy for manifests, metrics, model weights, and demonstration media.

## Evidence acceptance checklist

G5 may move from `BLOCKED` only when all applicable items have durable, dated evidence:

- [ ] Project owner approves the intended product/research use.
- [ ] Privacy reviewer approves the consent, retention, access, deletion, withdrawal, and downstream-model invalidation plan.
- [ ] Licence reviewer confirms permitted use for every external dataset, annotation, reference asset, checkpoint, and dependency.
- [ ] An SGSL-fluent Deaf reviewer is engaged and approves the five-sign vocabulary and review protocol.
- [ ] Every sample has provenance, consent, permitted-use, signer, label, capture-condition, and artifact-integrity metadata.
- [ ] Enough signers are reserved for validation and a locked final test that are never used for fitting or threshold selection.
- [ ] The dataset contains genuine negative and rejection examples, not only supported signs.
- [ ] The approved data can be transformed locally into the exact versioned `[30,224]` feature contract.

## Safe response handling

Store approvals and sensitive correspondence outside the Git repository. Commit only non-sensitive attestation IDs, dates, scope, checksums, and reviewer status. Never commit participant names, contact details, consent forms, raw recordings, derived participant tensors, or private access URLs.

After G5 clears, run the same TCN and GRU comparison on the frozen split, select by validation evidence, evaluate the locked test once, export the selected checkpoint, verify Python/ONNX/Java parity, and execute the genuine browser-to-`caption.final` and rejection gates.
