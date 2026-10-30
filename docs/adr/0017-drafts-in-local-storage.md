# ADR-0017: Unsaved answers in browser local storage; no service worker

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

FR-DEC-06.

## Decision

Drafts live in `localStorage`, per account and question. They are cleared on confirmed save, on
sign-out and after 7 days (NFR-PRIV-06). There is one automatic retry when the browser reports it is
back online (NFR-REL-05).

## Consequences

Works on any current browser. No offline browsing of pages.

## Alternatives rejected

- A service worker with a request queue. Rejected for v1: caching rules and stale application
  versions after a deploy are a source of hard-to-reproduce faults.

## References

- SRS 9.7 ADR-C8 (line 3756).
- FR-DEC-06, NFR-PRIV-06, NFR-REL-05.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
