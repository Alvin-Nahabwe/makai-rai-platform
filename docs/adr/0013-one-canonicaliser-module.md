# ADR-0013: One canonicaliser, as a dependency-free ES module shared by the app and the ops scripts

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

The seal check must run in the nightly restore test (FR-REV-06, NFR-INT-07), which runs a throwaway
database with no network, outside the Next.js server. The runner image holds no TypeScript sources
(9.1). The project already shares one pure module between app tests and ops scripts this way:
`ops/host/integrity-hash.mjs`, imported by `__tests__/integration/integrity-log.test.ts:4` and run by
`ops/host/auditlog.mjs`.

## Decision

The canonical JSON writer, the salted digest and the fingerprint live in one `.mjs` module with no
imports outside Node's standard library. The app imports it. A small seal-check script built on it runs
in the web image against the restored database, as `auditlog.mjs` does.

## Consequences

One implementation (NFR-MNT-05): test vectors run against it once and hold for both uses. The module
must be added to the image (Dockerfile copy step) and to the restore-test install map.

## Alternatives rejected

- TypeScript in the app only. Rejected: the restore test cannot run it.
- Two implementations. Rejected: they diverge.

## References

- SRS 9.7 ADR-C3 (line 3730).
- FR-REV-06, NFR-INT-07, NFR-MNT-05; SRS 9.1 (the runner image).
- `ops/host/integrity-hash.mjs`, `ops/host/auditlog.mjs`, `__tests__/integration/integrity-log.test.ts:4`.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
