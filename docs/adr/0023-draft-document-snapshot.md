# ADR-0023: A draft provenance for the document snapshot

**Status:** Accepted · **Date:** 2026-11-19 · **Deciders:** owner (path-to-outputs design, approved 19 Nov 2026 17:05 EAT: approach 1, "a live snapshot through the existing pipeline"); the snapshot's shape is the builder's call (design §7)

## Context

The working report's drafts are the data card, model card and mitigation plan, rendered from a team's current answers
instead of a seal. The design rejects a second renderer (anti-goal 2: the draft and the issued document must not disagree
on a field filled from answers) and rejects storing drafts in `issued_documents` (anti-goal 5: "issued" keeps meaning
issued). So the one resolver, `resolveFields` in `lib/documents/resolve.ts`, has to read a snapshot that holds no seal.
Until now `DocumentSnapshot` assumed one everywhere: every stage carried a seal id and fingerprint, and a missing stage
meant "never sealed" (D3).

## Decision

- `DocumentSnapshot.provenance` is a discriminated union: `{ kind: 'sealed' }` or `{ kind: 'draft'; takenAt }`.
- Each stage's `seal` is `StageSeal` (`kind: 'sealed'`, today's fields) or `StageDraft` (`kind: 'draft'`,
  `key: 'draft:<stage>'`, `takenAt`, and the stage's reviews by name and state, never their seals).
- `SealedSnapshot` narrows the snapshot to sealed provenance and sealed stages. `readDocumentSnapshot`
  returns it, and the issue path (`build`, `issueDocument`, `previewDocument`) takes it, so tsc refuses a draft there.
  `__tests__/unit/sealed-snapshot-type.test.ts` holds that refusal as a `@ts-expect-error`; its real check is `tsc --noEmit`.
- Every branch on `provenance.kind` or `seal.kind` names both arms, with no default arm. When a third
  kind is added, tsc then lists every place that has to decide what it means.
- `resolveFields` refuses a snapshot whose stages disagree with its provenance, so a draft never reads a
  seal's rows and a sealed document never prints a draft stage.
- The draft rules, applied by the same resolver:
  - A stage with no answers: a draft holds every stage. One with no current decision, gate-derived entry or finding
    reads "Not recorded yet", where a never-sealed stage of an issued document reads "Not recorded: this stage had no seal
    when the document was issued".
  - Typed fields: a draft never reads typed values. A field with a typed source and no value beside it reads "Added when
    the document is issued". A typed addition resolves as the issued field does with nothing typed.
  - The seals fields (MP-10, DC-33, MC-31) read "Not sealed".
  - MP-01 names the stage's review state: none, open, or the last one sealed.
  - MP-04 reads the running content and lists suggested controls only when its risk-area mapping is approved. Until
    then it prints a placeholder (anti-goal 3).
  - A draft returns no seal ids, so nothing it prints can be recorded as a seal a document used.

## Consequences

- One resolver serves both kinds, so a field filled from answers cannot drift between the draft and the issued document. The
  draft-resolve tests compare the two directly for typed additions and answered mixed fields.
- `ResolvedPart.sealIds` became `stageKeys` (a seal id or `draft:<stage>`). `resolveFields` still returns `sealIds`, sealed
  ones only, in the same order, which is what `issued_document_seals` stores.
- Hand-built snapshots in tests carry the two discriminants. The protected `document-resolve.test.ts` changed only in its
  module fixture (ledger entry in `__tests__/lint/test-replacements.json`).
- The draft builder (`lib/data/documents.ts`, Task 6) has to fill `StageDraft.openReview` and `lastSealedReview` from the
  stage's reviews and never read a seal's manifest or sealed answers.

## Alternatives rejected

- **A separate `DraftSnapshot` type and a draft resolver.** Rejected by anti-goal 2: the field logic would split in two.
- **Optional seal fields (`seal?: …`) with `null` for a draft.** Rejected: nothing would force a consumer of `fingerprint`
  or `sealId` to decide what a draft prints, and a missing seal already means "never sealed" (D3).
- **Provenance on the snapshot only, with no per-stage kind.** Rejected: the seal facts are per stage, and the stage key and
  MP-01 need a per-stage arm. The two are kept consistent by the check at the top of `resolveFields`.

## References

- Design: `Claude outputs/2026-11-19-path-to-outputs-design.md`, §4 anti-goals 1, 2, 3 and 5, and §7 "Snapshot provenance".
- Plan: Task 5 (this record); Task 6 (the draft builder); controller's rulings 8 and O2 (MP-01), O6 (typed additions), 22 (no export without a consumer).
- `lib/documents/resolve.ts` (`stageGap`, `assertOneProvenance`, `resolveFields`), `lib/documents/copy.ts` (the draft words).
