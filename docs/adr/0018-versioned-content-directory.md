# ADR-0018: Versioned content directory, and resources outside the hash

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

*Decided in the core (FR-CNT-05, FR-CNT-07, core call 21); recorded here because the repository had no ADR for it.*

## Context

None recorded in SRS 9.7 beyond the core's decision (FR-CNT-05, FR-CNT-07, core call 21).

## Decision

`data/content/<semver>/` holds the hashed files of every published content version.
`data/resources.json` (templates, notebooks, review records, notebook hashes) is outside
`BUNDLE_FILES`.

## Consequences

The directory must sit under `data/` so the existing tracing include in `next.config.ts` carries it
into the image (9.6). Old directories are never deleted while any version points at them.

## Alternatives rejected

None recorded in SRS 9.7.

## References

- SRS 9.7 ADR-C9 (line 3762).
- FR-CNT-05, FR-CNT-07; core call 21; SRS 9.6; `next.config.ts`.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
