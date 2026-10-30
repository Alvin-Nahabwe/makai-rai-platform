# Architecture Decision Records

Adopted 2026-08-02 (`AGENTS.md` rule 7). Architectural decisions get an ADR here so the
*reasoning* survives, not just the outcome. Twice on this project a data-layer decision was
made without its rationale written down, and both times the reasoning had to be reconstructed
from code.

## When an ADR is required

Write one when a decision:
- shapes how components interact, or where a responsibility lives;
- is expensive to reverse (schema shape, tenancy model, auth strategy, API surface);
- has a plausible alternative a future reader would otherwise re-litigate;
- or was contested and resolved — record why the loser lost.

Not required for routine implementation choices with an obvious default.

**ADR vs `what-if-oracle`:** an ADR records a decision and its consequences. `what-if-oracle`
is for decisions that are genuinely *irreversible* and need scenario analysis before
committing. An irreversible fork gets both; a wide-reaching but reversible decision (an
internal API shape) gets an ADR alone.

## Format

`NNNN-short-kebab-title.md`, numbered sequentially. Sections: Context · Decision ·
Consequences (positive and negative/accepted) · Alternatives rejected · References.

Status is one of `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Superseded in part by ADR-NNNN` · `Deprecated`.
**ADRs are never edited to change a decision** — supersede them with a new one and update the
old one's status. The record of what we used to believe is the point.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-data-access-architecture.md) | Data-access architecture: RLS owns isolation, the app owns authorization | Superseded in part by ADR-0009 |
| [0002](0002-identity-and-account-linking.md) | Identity, sessions, and account linking: the token asserts identity and nothing else | Proposed |
| [0003](0003-framework-version-registry-third-lane.md) | Framework version registry: a third data-access lane for global reference data | Accepted |
| [0004](0004-eight-principles-from-unesco-ten.md) | The framework's eight principles, and how they relate to UNESCO's ten | Accepted |
| [0009](0009-identity-lane-role.md) | The identity lane connects as `makrai_identity`, not as the schema owner | Accepted |
| [0010](0010-break-glass-and-integrity-log.md) | Console break-glass, and the integrity log that records it | Accepted |
| [0011](0011-contract-first-build.md) | Contract-first build: schema, types and fixtures merged before parallel work | Accepted |
| [0012](0012-append-only-version-tables.md) | Append-only version tables; current state derived, never stored | Accepted |
| [0013](0013-one-canonicaliser-module.md) | One canonicaliser, as a dependency-free ES module shared by the app and the ops scripts | Accepted |
| [0014](0014-reminder-job-internal-route.md) | The hourly reminder job runs through an internal route that host cron calls | Accepted |
| [0015](0015-files-stay-in-postgresql.md) | Evidence bytes and issued PDFs stay in PostgreSQL in v1 | Accepted |
| [0016](0016-team-export-zip-from-temporary-file.md) | Team export streams a ZIP from a temporary file | Accepted |
| [0017](0017-drafts-in-local-storage.md) | Unsaved answers in browser local storage; no service worker | Accepted |
| [0018](0018-versioned-content-directory.md) | Versioned content directory, and resources outside the hash | Accepted |
| [0019](0019-sign-in-limits-per-account.md) | Sign-in limits per account at every layer, with a spraying alarm | Accepted |
| [0020](0020-expand-only-v060.md) | Expand-only v0.6.0 with frozen legacy tables | Accepted |
