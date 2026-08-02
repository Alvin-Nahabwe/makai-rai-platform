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

Status is one of `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`.
**ADRs are never edited to change a decision** — supersede them with a new one and update the
old one's status. The record of what we used to believe is the point.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-data-access-architecture.md) | Data-access architecture: RLS owns isolation, the app owns authorization | Accepted |
| [0002](0002-identity-and-account-linking.md) | Identity model and account-linking policy | Accepted |
