# ADR-0003 — Framework version registry: a third data-access lane for global reference data

**Status:** Accepted · **Date:** 2026-08-09 · **Deciders:** human partner + engineering
**Related:** ADR-0001 (data-access architecture), ADR-0002 (identity and sessions)
**Register:** D-138, D-143, D-144, D-147, D-163
**Note on dating:** the decision this ADR records was taken during Plan 1c's design
(2026-08-06) and implemented in Task 1 (commit `fc9b15e`) and Task 2. Writing it down was
named as this phase's own obligation (`docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md:72`,
D-144) and, per that row, not discharged until now — formalised at the Phase 1c phase-exit
register reconciliation rather than left as a citation to a document that did not exist.

## Context

ADR-0001 established two data-access lanes: tenant tables behind `withOrg` + RLS (the
isolation boundary), and identity/consent behind `identityDb` on the superuser/BYPASSRLS
connection — deliberately narrow, held to a frozen, constructed-not-intercepted surface after
four failed interception attempts (D-092). Every table in the schema was either tenant-scoped
or identity-scoped, so two lanes were sufficient.

Plan 1c introduces the first table that is neither: `framework_versions`, a registry recording
which named, hashed content bundle each assessment was pinned against. It has no `orgId` — a
framework version is shared across every organization on the platform, not tenant data — and
it is not identity data either. Left undecided, the design spec named the likely accident
explicitly: it would land on the identity connection, because that is where "not tenant data"
currently routes, which would put a read-mostly, non-sensitive registry table on the one
connection this project has spent two phases keeping narrow (D-081, D-092, D-099).

## Decision

**A third lane: global reference data, read directly by the restricted application role.**

```
model FrameworkVersion {
  id           String   @id
  semver       String   @unique
  contentHash  String
  publishedAt  DateTime
  status       String   @default("published")
  createdAt    DateTime @default(now())
}
```

No RLS — there is no `orgId` column for a policy to filter on, confirmed by the tenant-table
DDL guard (`20260803074244_.../migration.sql`) not touching it. `makrai_app` (the same
restricted role every `withOrg` transaction runs as) holds exactly one privilege on this
table: `SELECT`, granted in `20260807102031_framework_registry_and_pin/migration.sql:32`. No
`INSERT`, `UPDATE` or `DELETE` — the registry is populated by migration, not by application
code.

**Verified by spike before deciding, not assumed** (2026-08-06, `docker exec … psql` against
the real roles):

| Spike | Result |
|---|---|
| `makrai_app` SELECTs `framework_versions` with no grant | `ERROR: permission denied` |
| `makrai_app` INSERTs a tenant row whose FK points at `framework_versions` | `INSERT 0 1` — succeeds |
| …with a value that matches no row | rejected, violates foreign key constraint |
| …writing that row for another org | rejected, violates row-level security policy |

Referential-integrity checks run with the **referenced** table's rights, not the inserting
role's — so `assessments.frameworkVersionId`'s foreign key holds even with zero grants on
`framework_versions`. The `SELECT` grant is not required for correctness; it exists because
the application reads this table directly, for two independent reasons (below).

**Why a new lane, rather than routing through `identityDb`:** the identity lane exists
specifically because non-tenant data has meant *sensitive* data (`User.passwordHash`,
`ConsentRecord`), and its narrowness is the point — almost nothing should reach it (D-092:
four failed interception attempts before a frozen, constructed surface held).
`framework_versions` is the opposite shape: non-sensitive, read-mostly, and needed on the hot
path of every assessment creation and every report render. Routing it through `identityDb`
would either force those reads onto the superuser/BYPASSRLS connection for no security reason,
or special-case a lane deliberately built to have none. A direct, least-privilege grant on the
restricted role is the smaller change and leaves the identity lane's own guarantee intact.

**Once granted, the `SELECT` read is load-bearing for two independent things — this corrects a
claim made during Task 1 design that has since become false:**

1. **Display.** `getPinnedVersion` (`lib/data/framework.ts`) reads an assessment's pin back for
   the report's provenance line ("Assessed against MAK-AI RAI Framework 3.0.0, pinned …"), and
   the drift check `resolveFramework` layers on top of it gates whether `PATCH
   .../assessments/[id]` and `POST .../complete` may proceed once deployed content has moved
   since the pin (Task 9, O-14).
2. **Creation.** `resolveCurrentFramework` → `resolvePublishedVersion` (`lib/data/framework.ts`)
   runs `tx.frameworkVersion.findFirst({ where: { semver, status: 'published' } })` inside the
   same transaction as every `POST .../assessments` (fix round 1, closing D-143 — the plan's
   file list enumerated *readers* of the pin and never asked which file *writes* it). No
   fallback: an unresolvable semver throws rather than defaulting, so an assessment that cannot
   be pinned cannot be created.

The design spec originally documented only reason 1 and stated that if the display requirement
were ever removed, the grant would go with it. That is no longer true. Removing the provenance
line would **not** let the grant be dropped, because creation depends on it too. The spec
itself already carries this correction (dated 2026-08-08); `prisma/schema.prisma`'s
`FrameworkVersion` doc comment and `lib/data/framework.ts`'s `getPinnedVersion` doc comment
repeated the original, now-stale claim and are corrected in the same commit as this ADR.

**Write-once, enforced at the database, not the application.** Once an assessment is created,
its `frameworkVersionId` may never change —
`trg_assessments_framework_version_write_once` (`20260807102031_.../migration.sql`), a `BEFORE
UPDATE OF "frameworkVersionId"` trigger that raises rather than allowing the column to move. An
assessment records the framework version it was answered against; changing that after the fact
would rewrite history silently. Enforced as a trigger rather than only an application check
because a trigger holds regardless of which code path performs the update, present or future —
the same reasoning ADR-0002 gives for branding `OrgContext` over a runtime assertion (D-092: a
value that cannot be constructed needs no imagination from a future caller; a column that
cannot be moved needs none either).

## Consequences

### Positive

- Framework metadata reads (creation-time pin resolution, report-time pin read-back, drift
  checks) run on the same restricted, RLS-governed connection as the rest of the request — no
  new connection, no new pool, no widening of the superuser/BYPASSRLS surface ADR-0002's own
  negative consequences worry about.
- Least privilege is real, not nominal: `SELECT` only, verified live against the actual role
  (not inferred from the Prisma schema), with no application path to `INSERT`, `UPDATE` or
  `DELETE` a framework version.
- The write-once trigger makes "which content was this assessment answered against" a fact the
  database enforces, not a fact the application promises to maintain — closing the gap Plan 1c
  exists to close (design spec §0: "no assessment in this database records which content it was
  answered against").
- Referential integrity holds even in the counterfactual where the `SELECT` grant is later
  revoked, because RI checks run with the referenced table's rights — verified by spike, not
  assumed.

### Negative / accepted

- **A third lane is a third thing to remember.** `AGENTS.md` §3 already names "components
  verified in isolation compose into a broken system" as this project's recurring failure
  shape; a reader who knows ADR-0001's two lanes and not this one could still misroute a future
  global-reference-data table onto tenant or identity access by habit. Mitigated by this ADR
  and by the `FrameworkVersion` model's own doc comment naming it explicitly; not eliminated.
- **The registry has no concept of "current."** `status` distinguishes `published` from
  `deprecated` — a validity state, not a currency marker — so "the version a new assessment
  should get" exists only as an exact string match between `data/assessmentAreas.json`'s
  `meta.version` and a `framework_versions.semver` row, reconciled at runtime with nothing in
  the schema tying them together. Deliberately not fixed here: promoting "current" into the
  data model is a framework data-model change, and D-137/D-138 give the framework data model to
  Plan 2a. Doing it in Plan 1c would foreclose exactly what D-137 binds this phase not to
  foreclose. D-147 records the gap; a test (Task 1 fix round 2) asserts the two strings agree
  today, converting a future silent drift into a visible failure rather than fixing the
  structural gap.
- **Framework content itself stays in files, not this table.** `framework_versions` is a
  registry (id, semver, contentHash, publishedAt, status) — not the content. Content-as-database-
  rows is explicitly Plan 2a's scope (D-137, D-138), taken up together with the domain axis so
  both content decisions are made once.
- **No `UPDATE` grant means no in-place correction.** A `framework_versions` row, once created,
  can only be superseded by a new row (`status: 'deprecated'` plus a new `published` row), never
  edited. Consistent with the write-once philosophy applied to assessments, but means an
  operator who publishes a bad `contentHash` needs a new migration to correct it, not a one-line
  `UPDATE`.
- **The declarative schema and the database can drift silently.** `schema.prisma` has no
  `@@unique`/constraint mirror for at least one constraint written directly into migration SQL
  elsewhere in this phase (D-163, on the sibling `Evidence` model) — noted here because the same
  risk class applies to any future hand-written constraint on `framework_versions` and is worth
  a reader's attention, not because this table currently has an instance of it.

## Alternatives rejected

- **Route through `identityDb`.** Rejected: `framework_versions` is not sensitive and not
  identity-scoped. Forcing it onto the superuser/BYPASSRLS connection would widen exactly the
  surface ADR-0002 and D-092 spent effort narrowing, for a table with no security reason to be
  there.
- **No grant at all, rely only on the FK for integrity.** Rejected once both reads (display and,
  later, creation) were identified: the FK alone satisfies referential integrity, but
  `getPinnedVersion` and `resolveCurrentFramework` need the row's `semver`/`contentHash`/`status`,
  not merely confirmation that it exists.
- **Give `makrai_app` broader privileges (`INSERT`/`UPDATE`) on `framework_versions`.** Rejected:
  nothing in the application ever needs to create or modify a framework version — that is an
  operational/migration act — and granting write access the application never uses is exactly
  the over-broad-grant shape D-075's own pick-up trigger warns against ("the temptation will be
  to re-grant the whole table").
- **Treat this as an extension of the tenant lane** (add a nullable `orgId`, RLS with a
  permissive `orgId IS NULL OR …` policy). Rejected: it would make a genuinely global table's
  access depend on the tenant-context GUC, coupling a read that has no organization yet to
  machinery built for a different purpose, for no isolation benefit — there is nothing here to
  isolate.

## References

- `docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md` §2.1 — the design
  decision and its 2026-08-08 correction, incorporated here
- ADR-0001 — data-access architecture (the two lanes this one extends)
- ADR-0002 — identity and sessions (D-092's construction-over-interception reasoning, reused
  here for the write-once trigger's rationale)
- `prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql` — the `GRANT` and
  the write-once trigger
- `lib/data/framework.ts` — `getPinnedVersion`, `resolvePublishedVersion`,
  `resolveCurrentFramework`, `resolveFramework`
- Register: D-138 (D-003 splits: 1c does pinning, Plan 2a does content-as-data), D-143 (the
  write-path gap whose fix made the `SELECT` grant load-bearing for creation), D-144 (this row,
  closed by this document), D-147 (the version-currency gap, deliberately not fixed here), D-163
  (the sibling schema/migration drift risk noted above)

---

## Amendment, 2026-08-09 — C6 whole-branch review, F5

Two function names in this ADR changed, and one of them changed meaning:

| Was | Is | Why |
|---|---|---|
| `resolvePublishedVersionId(semver, tx): Promise<string>` | `resolvePublishedVersion(semver, tx): Promise<PinnedVersion>` | Returns the whole row, because `contentHash` is now needed at creation time |
| `getCurrentVersionId(tx): Promise<string>` | `resolveCurrentFramework(tx): Promise<FrameworkResolution>` | **Behaviour change, not a rename.** It now also reports whether the deployed bundle still hashes to what that row records |

The defect this closes: creation resolved the version to pin **by semver string only** and
never compared hashes, so content edited without a `meta.version` bump still resolved to the
same registry row and `POST .../assessments` returned 201 — pinning a new assessment to a
version it did not match. The first autosave then hit `respondToAssessment`'s drift check and
409'd permanently, with no in-product remedy (D-167). The three O-14 guards this ADR's lane
already had all sat on writes to an *existing* assessment; the write that brings one into
existence was outside the enumeration. `__tests__/integration/trigger-enumeration.test.ts` now
pins four sites, not three.

The old names are **deleted, not aliased**: an alias would be an export with no production
caller, which is the defect class the same review round is closing elsewhere.
