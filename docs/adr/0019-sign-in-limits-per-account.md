# ADR-0019: Sign-in limits per account at every layer, with a spraying alarm

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

Ruling 10. NFR-SEC-06 found the nginx zone.

## Decision

Remove the per-address limit from `/api/auth/` in nginx and in `proxy.ts`, and exempt sign-in from
the default per-address rule. Keep the per-account lock, made to hold as FR-ACC-05 now sets out
(atomic count, restart after expiry, dummy hash, known-device count, a process-wide ceiling of 300 a
minute, at most 4 comparisons at once). Add NFR-OBS-04's alarms. No per-address ceiling is kept in
nginx, not even a high one for floods: ruling 10 keeps sign-in limits per account, not per IP address,
and only the owner can relax it. Flood protection comes from the process-wide ceiling, with
known-device browsers exempt (FR-ACC-05; call R-49).

## Consequences

None recorded in SRS 9.7 beyond the decision itself.

## Alternatives rejected

- Per-address limits with an allow-list of institutional addresses. Rejected: addresses change and
  the list would need upkeep by MAK-AI.

## References

- SRS 9.7 ADR-C10 (line 3766).
- NFR-SEC-06, FR-ACC-05, NFR-OBS-04; ruling 10; call R-49.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
