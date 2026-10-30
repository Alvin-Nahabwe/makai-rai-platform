# ADR-0012: Append-only version tables; current state derived, never stored

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

*Decided in the core (SRS 5.3, 5.9 call 1); recorded here because the repository had no ADR for it.*

## Context

Ruling 2 keeps every change. Ruling 5 seals what cannot be rewritten.

## Decision

Every record change is a new row. Triggers refuse UPDATE, DELETE and TRUNCATE for every role.
"Current decision" and "finding state" are computed from history.

## Consequences

Reads that need the current state use an index on `(..., versionNumber DESC)` or a view with
`security_invoker` (views without it are refused by migration 9's guard, R3 section 4). History only
grows.

## Alternatives rejected

- Mutable rows plus an audit table. Rejected: the audit table becomes the record and the mutable row
  can drift.
- A per-project hash chain. Rejected in core 5.9.

## References

- SRS 9.7 ADR-C2 (line 3724).
- SRS 5.3 and 5.9 call 1 (the core's decision); R3 section 4 (the views guard).
- Rulings 2 and 5. NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
