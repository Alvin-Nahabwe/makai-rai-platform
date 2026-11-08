# ADR-0015: Evidence bytes and issued PDFs stay in PostgreSQL in v1

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

Evidence bytes are already in `evidence_blobs` (R3 section 12). Issued PDFs must be stored
(FR-DOC-04).

## Decision

Store PDFs in `issued_documents.pdf` (bytea), like evidence.

## Consequences

One backup, one isolation mechanism, one transaction for the document row and its bytes. The database
and the in-memory restore test grow with files (NFR-REL-03). Pick-up trigger: database size over 2 GB,
or the restore test's load step over 15 minutes.

## Alternatives rejected

- Object storage. Rejected for v1: a second store to back up, isolate and restore-test, on the
  critical days.

## References

- SRS 9.7 ADR-C6 (line 3744).
- FR-DOC-04, NFR-REL-03; R3 section 12.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
