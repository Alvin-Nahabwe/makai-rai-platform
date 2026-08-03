# ADR-0001 — Data access: RLS is the authoritative tenant filter; the app owns authorization

**Status:** Accepted · **Date:** 2026-08-02 · **Deciders:** engineering + product owner
**Supersedes:** `docs/superpowers/specs/2026-08-02-phase1-foundation-design.md` §3.1 and §3.2
**Re-derived** after the Phase-1a rollback (register D-063). An earlier ADR-0001 existed; it was
written without `senior-architect`, `database-design:postgresql` or `senior-security` input and
was set aside on branch `rollback/phase1a-unadherent`. This document was derived from the spike
and the codebase first, then cross-checked against it (rule 5: reference, not mandate).

## Context

Phase 1 makes the platform multi-tenant. A systemic IDOR in this same codebase (2026-07 audit)
is what motivated the rebuild, so the isolation mechanism is the load-bearing decision of the
phase.

**Call-site census, re-derived from the baseline tree rather than inherited** (rule 8):

| Fact | Value |
|---|---|
| Files importing the Prisma client | **22** |
| Total `prisma.<model>.` call sites | **50** |
| Non-tenant call sites (`user` ×14, `consentRecord` ×3) | **17** |
| Tenant call sites (`assessment` 16, `project` 11, `remediationItem` 5, `projectMetadata` 1) | **33** |
| Files touching **only** non-tenant models | **6** |
| Call sites inside `app/(authenticated)/**` server components | **7 files** |

Two of those rows drive the design. **17 of 50 call sites are not tenant data at all** — login
reads `User` before any organization is known — so a single universal wrapper structurally
cannot serve the application. And **7 files are React Server Components** querying directly, so
the tenant boundary must hold during RSC render, not only in API routes.

The Task 0 spike (`docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`) settled the
mechanism question empirically:

- `$extends({$allModels.$allOperations})` **does not work**. The hook receives a `query()`
  already bound to the base client, so `set_config` and the query execute on different pooled
  connections. It fails closed and silent — 0 rows, no error — which is what makes it dangerous.
- `withOrg(ctx, cb)` — one interactive transaction, the callback handed the `tx` handle —
  passed every probe, including cross-org read by primary key, `WITH CHECK` on writes, and
  **no GUC residue on a reused pooled connection**.

### What the superseded spec got wrong

Spec §3.1 described three layers and gave the middle one two jobs: "`orgId` injected; role
enforced". That is three concerns in one helper (`orgDb(activeOrgId, membership)` also set the
session variable), which AGENTS.md rule 7 names as a design defect — and it is why it was
ambiguous whether that helper filtered at all.

The correction is **not** that the middle layer is redundant. It is that the spec was wrong
about *what it does* and *how it fails*:

| | Spec §3.1 said | Actually |
|---|---|---|
| What the middle layer does | injects `orgId`, enforces role | **establishes tenant context**; enforces authorization; injects nothing |
| How it fails | omission | omission — but omission now fails **CLOSED** |

That last cell is the crux. With RLS as the sole filter, a route that forgets `withOrg` runs
with no GUC set, and the fail-closed policy returns **zero rows**. Under application-level
filtering, a forgotten `where` clause returns **every tenant's rows**. The layers still fail
independently; the middle layer's failure mode is simply far safer than the spec assumed.

## Decision

**Four layers, one responsibility each.**

```
Session / identity       NextAuth — who is this person?              lib/auth.ts
      ↓ userId
Pre-context reads        preauth.ts — the few before-context reads   lib/data/preauth.ts
      ↓ memberships, org-by-slug, invitation-by-token
Context / authorization  requireOrgContext(slug, action)             lib/data/context.ts
      ↓ OrgContext { orgId, role }   membership lookup + can(); 404 if not a member
Tenant data access       withOrg(ctx, tx => …)                       lib/data/tenant.ts
      ↓ sets app.current_org_id       NO filtering logic
Database                 RLS policies + FORCE + composite same-org FKs
                         the authoritative tenant filter
```

Non-tenant models (`User`, `ConsentRecord` — 17 of 50 call sites) go through
`lib/data/identity.ts` on the unscoped client: a documented boundary, not an accident.

1. **RLS is the authoritative tenant filter. The application never re-filters by `orgId`.**
   A `where: { orgId }` in application code is a multi-tenant *design* filter, which is RLS's
   concern by definition. Application code filters only for *domain* reasons — status, date,
   ownership within a tenant.

2. **Authorization is the application's job and never appears in RLS policies.** Policies stay a
   single indexed comparison; `can(role, action)` is a pure function in `lib/authz/policy.ts`.
   (The existing `lib/authz.ts` is deleted, not extended — its ownership premise,
   `assessment.userId !== user.id`, is wrong under tenancy, where a colleague in the same org
   legitimately reads a project they did not create.)

3. **Permission checks are folded into context acquisition.** `requireOrgContext(slug, action)`
   returns a context *or throws*. A route cannot obtain the ability to query without declaring
   what it intends to do, so the check cannot be forgotten per-route. Unauthorised access to an
   existing resource returns **404**, never 403 — org existence is not leaked to slug probing.

4. **Before-context reads live in one narrow, named module.** `lib/data/preauth.ts` exposes
   exactly the reads that must happen before any org context exists — resolving a user's
   memberships at login, an organization by slug, an invitation by token. These are inherently
   cross-org ("which orgs am I in" cannot be org-scoped), so **no RLS policy can serve them**;
   they run on the owner connection. A test pins the module's exported surface so the bypass
   stays enumerable and auditable instead of quietly growing. This is the deliberate answer to
   D-061, decided here rather than discovered mid-implementation.

5. **No repository layer initially.** Functions that merely wrap `tx.project.findMany()` are
   pass-through indirection with no logic to hold. Repositories get introduced only where
   genuine shared query logic emerges (YAGNI). Revisit when the same non-trivial query appears
   in three or more call sites.

## Keeping RLS non-decorative — six structural controls, zero redundant application code

| # | Control | Prevents |
|---|---|---|
| 1 | `FORCE ROW LEVEL SECURITY` on every tenant table | Non-superuser table-owner bypass |
| 2 | Non-superuser, `NOBYPASSRLS` application role | Privileged bypass |
| 3 | Fail-closed policy: `"orgId" = NULLIF(current_setting('app.current_org_id', true), '')` | Unset context returning rows, or erroring |
| 4 | Postgres DDL event trigger auto-enabling RLS on new tenant tables | A new tenant table shipping without protection |
| 5 | T1 enumeration test over `pg_class.relrowsecurity` + `relforcerowsecurity` | Whatever control 4 cannot reach |
| 6 | ESLint ban on importing the raw client outside `lib/data/` | Routes bypassing the boundary |

Two constraints on control 4, both learned the hard way:

- The trigger must resolve columns via **catalog/OID lookup** (`pg_attribute` on `obj.objid`),
  never by reconstructing a name from `object_identity` — that string is quoted for mixed-case
  identifiers, and `split_part` on it silently matched nothing, so a tenant table would have
  shipped with RLS off, with no error and no notice (D-064).
- It binds only tables created **after** installation, and does not fire on
  `ALTER TABLE … ADD COLUMN "orgId"` — which is the exact pattern this project used to port its
  existing tables. Control 5 is the backstop for both gaps, not a formality.

**No `::uuid` cast.** `orgId` is a `text` column; Postgres has no `text = uuid` operator and
`CREATE POLICY` fails outright with the cast (D-064). Text-to-text comparison is exact-match,
index-friendly, and still fails closed through `NULLIF`.

## Consequences

**Positive.** One authoritative isolation mechanism, enforced by the database and unbypassable by
application bugs. Isolation is data-level, authorization is application-level, and neither
duplicates the other, so there are no predicates to drift out of sync. Forgetting the boundary
fails closed. Most importantly, isolation is **provable**: RLS can be observed failing, because
nothing else is quietly filtering underneath it.

**Negative / accepted.**

- Every tenant call site becomes `withOrg(ctx, tx => …)` rather than a bare client call. More
  ceremony — and the tenant boundary becomes lexically visible, which is an auditability gain.
- **Every request holds an interactive transaction for its duration.** This makes tenant
  isolation dependent on connection-pool behaviour. The spike showed no cross-contamination
  across 10 concurrent interleaved calls, but those were trivial queries, not a traffic model.
  Prisma's transaction `timeout` and `maxWait` defaults become load-bearing and are currently
  unpinned (**D-065**). Behaviour behind an external pooler depends on its mode: PgBouncer
  **session** and **transaction** pooling both work with this design (the whole interactive
  transaction runs on one server connection, and `set_config(..., true)` is transaction-scoped,
  so nothing outlives it); **statement** pooling does not, because it cannot hold a
  multi-statement transaction at all. Hosting is still parked (**D-018**). Note the corollary:
  under transaction pooling a *session*-scoped GUC (`set_config(..., false)`) would be actively
  unsafe — which is a second, independent reason the `true` argument is mandatory.
- **A superuser bypass cannot be closed at the database layer.** `FORCE` binds a non-superuser
  *owner*; it does nothing to a superuser or a `BYPASSRLS` role. The schema owner (`makrai`) is
  a superuser, so it sees every tenant's rows regardless of policy. Containing it is an
  **architectural claim about role separation** — the application connects as a restricted role
  — not a property RLS provides. Stated explicitly because the rolled-back implementation
  carried a comment asserting the opposite.
- `organizations` has no `orgId` column, so neither control 4 nor control 5 covers it, and
  slug→org resolution is a before-context read by definition (**D-062**).

## Alternatives rejected

- **Belt and braces — RLS *plus* application-level `orgId` injection.** Rejected on
  **provability**, not purity. A redundant application filter masks exactly the misconfiguration
  RLS fails by: with both in place you can never observe RLS being broken, because the app
  filter silently becomes the real one. It also drifts, and it re-introduces the
  remember-to-filter discipline this rebuild exists to eliminate. The T1 enumeration test is the
  correct answer to "someone disabled a policy" — a second filter is not.
- **Application-layer filtering only, no RLS.** Simpler operationally, and it would dissolve
  D-065 entirely. Rejected on **failure mode**: app-layer filtering fails by *omission*, and one
  forgotten clause is a silent cross-tenant leak — precisely the IDOR class that motivated the
  rebuild. RLS fails by *misconfiguration*, which is enumerable and testable. That asymmetry is
  the whole case for RLS; it is not a performance argument.
- **An args-injecting `$extends` wrapper.** Falsified by the spike. Also rejected on principle:
  "automatic" is what made its failure invisible — it looked scoped, raised no error, and
  silently returned nothing.
- **Repository layer up front.** Pass-through indirection with no logic to hold (YAGNI).

## References

- Task 0 spike: `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [AWS Prescriptive Guidance — multi-tenant SaaS on managed PostgreSQL](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/best-practices.html)
- Register: D-061 (pre-context reads), D-062 (`organizations`), D-064 (identifier convention),
  D-065 (pool sizing), D-018 (hosting)
