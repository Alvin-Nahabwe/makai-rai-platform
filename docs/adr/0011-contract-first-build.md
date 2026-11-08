# ADR-0011: Contract-first build: schema, types and fixtures merged before parallel work

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

## Context

The build window is about 46 hours (SRS 13.2). The functional groups form a chain (schema,
decisions, findings, seals, documents) whose build hours, done one after another, exceed the window by
days (13.4, plan A).

## Decision

One Opus unit (K0) writes and merges, first: every v0.6.0 migration of 9.5 with its policies, grants
and triggers and their database tests; the TypeScript types and route shapes of every new service; and
a fixture builder. Every other unit then builds against K0 at once and integrates in dependency
order.

## Consequences

The schema is fixed early, so a defect in it costs rework in many units (risk RK-3, 13.9). K0 is on
the critical path and must be reviewed with `database-design:postgresql` and `senior-security` before
release to the other units.

## Alternatives rejected

- Each group designs its own tables. Rejected: the chain does not fit, and twenty migrations from
  different authors collide.
- One agent builds the whole record core. Rejected: about 42 hours alone, R5 Part C scale.

## References

- SRS 9.7 ADR-C1 (line 3718).
- SRS 13.2 (the build window), 13.4 (plan A), 13.9 (RK-3), 9.5 (the migrations).
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
