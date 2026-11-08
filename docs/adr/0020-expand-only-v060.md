# ADR-0020: Expand-only v0.6.0 with frozen legacy tables

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

*Decided in the core (SRS 11.2); recorded here because the repository had no ADR for it.*

## Context

None recorded in SRS 9.7 beyond the core's decision (SRS 11.2).

## Decision

Nothing v0.5.0 reads is dropped or renamed. Contraction is in a later release.

## Consequences

An application rollback is safe before the first real v1 record, and after it only as an emergency
stop (the rollback rule of SRS 13.8, `docs/runbooks/deployment.md` 9.5). A database restore is safe
only before the first real v1 record, because it discards every write since the backup.

## Alternatives rejected

None recorded in SRS 9.7.

## References

- SRS 9.7 ADR-C11 (line 3771).
- SRS 11.2 (the core's decision), 13.8 (the rollback rule).
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
