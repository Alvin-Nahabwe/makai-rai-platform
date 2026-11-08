# ADR-0016: Team export streams a ZIP from a temporary file

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

FR-EXP-01. One process. Time limits at nginx and Cloudflare.

## Decision

The handler reads the export's rows and files inside one `REPEATABLE READ` transaction into a
temporary file on the container's disk, commits, then returns a `ReadableStream` of that file with no
database connection held. Entries are uncompressed (files are mostly already compressed). At most 2
exports run at once across the platform, otherwise 429. The ZIP writer is a small, pinned library or a
hand-written store-only writer. The call: prefer a small library with no dependencies if one passes
NFR-SEC-15, else hand-write the store-only format. This record does not make that choice; the pull
request that adds the export records which was used.

## Consequences

No background job. Memory bounded (NFR-PERF-04). No connection or snapshot is held during a slow
download, which streaming straight from the transaction would have held for hours on a slow link (one
of the tenant pool's 10 connections, `lib/data/tenant.ts:125`). The first byte waits until the file is
written. Disk use is bounded by the storage cap (NFR-REL-09).

## Alternatives rejected

- Build the ZIP in memory. Rejected: one large organisation exhausts the process.
- A background job with a download link later. Rejected: it needs a job runner the app does not have
  (K-5).

## References

- SRS 9.7 ADR-C7 (line 3750).
- FR-EXP-01, NFR-PERF-04, NFR-REL-09, NFR-SEC-15; constraint K-5; `lib/data/tenant.ts:125`.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
