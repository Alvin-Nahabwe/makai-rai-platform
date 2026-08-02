# ADR-0001 — Data-access architecture: RLS owns isolation, the app owns authorization

**Status:** Accepted · **Date:** 2026-08-02 · **Deciders:** engineering + product owner
**Supersedes:** the data-layer description in `docs/superpowers/specs/2026-08-02-phase1-foundation-design.md` §3.1–§3.2

## Context

Phase 1 makes the platform multi-tenant. The Phase-0 codebase reaches Postgres from 50 call
sites across 22 files (35 in API routes, 10 in server pages, 5 in `lib/`). Every one of them
must move behind a boundary that guarantees tenant isolation, because a systemic IDOR in this
same codebase (2026-07 audit) is what motivated the rebuild.

The original spec described a single helper, `orgDb(activeOrgId, membership)`, which would
"inject `orgId` into every query **and** enforce the role policy" while also setting the
Postgres session variable that RLS reads. Three responsibilities, one helper, no stated
boundary.

Two findings forced a rethink:

1. **The implementation never matched the description.** The planned `$extends` wrapper set
   the RLS session variable and passed `args` through untouched — it never injected `orgId`
   into anything. The spec promised a layer the code did not provide.
2. **The mechanism did not work.** The Task-0 spike
   (`docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`) showed Prisma 7.8's
   `$allOperations` hook binds `query(args)` to the base client, not to the ambient
   transaction — so the session variable and the query landed on different connections.
   `withOrg(orgId, cb)`, which opens one interactive transaction and hands the caller the
   transaction handle, passed all nine probes including nested writes and pooling.

A third finding emerged from enumerating the call sites rather than reasoning abstractly:
**17 of 50 call sites are not tenant data at all** (`user` ×14, `consentRecord` ×3). Login
reads `User` before any org context exists. A single universal wrapper structurally cannot
serve them.

## Decision

**Four layers, one responsibility each.**

```
Session / identity      NextAuth — who is this person?              lib/auth.ts
      ↓ userId
Context / authorization requireOrgContext(slug, action)             lib/data/context.ts
      ↓ OrgContext { orgId, role }    membership lookup + can(); 404 if not a member
Tenant data access      withOrg(ctx, tx => …)                       lib/data/tenant.ts
      ↓ sets app.current_org_id       NO filtering logic
Database                RLS policies + FORCE + composite same-org FKs   migrations
                        authoritative tenant filter
```

Non-tenant access (`User`, `ConsentRecord`) goes through a deliberately separate
`lib/data/identity.ts` using the unscoped client — a documented boundary, not an accident.

**Specifically:**

1. **RLS is the authoritative tenant filter.** The application does **not** re-filter by
   `orgId`. A `where: { orgId }` in application code is a multi-tenant-*design* filter, which
   is RLS's concern by definition; duplicating it is a layering violation that happens to be
   redundant. Application code filters only for *domain* reasons (status, date, ownership
   within a tenant).
2. **Authorization is the application's job and never appears in RLS policies.** Policies stay
   a single indexed comparison; `can(role, action)` is a pure function in `lib/authz/policy.ts`.
3. **Permission checks are folded into context acquisition.** `requireOrgContext(slug, action)`
   returns a context *or throws*. A route cannot obtain the ability to query without declaring
   what it intends to do, so the check cannot be forgotten per-route.
4. **No repository layer initially.** Functions that merely wrap `tx.project.findMany()` are
   pass-through indirection. Repositories are introduced later only where genuine shared query
   logic emerges (YAGNI).

## Keeping RLS non-decorative — six structural controls, zero redundant application code

| # | Control | Prevents |
|---|---|---|
| 1 | `FORCE ROW LEVEL SECURITY` on every tenant table | Table-owner bypass |
| 2 | Non-superuser, `NOBYPASSRLS` app role | Privileged bypass |
| 3 | Fail-closed policy: `NULLIF(current_setting('app.current_org_id', true), '')::uuid` | Unset context erroring instead of returning nothing |
| 4 | Postgres event trigger auto-enabling RLS on new `public` tables | A new tenant table shipping without a policy |
| 5 | T1 enumeration test (`pg_class.relrowsecurity` + `relforcerowsecurity`) | Anything control 4 cannot cover (it binds only tables created after installation) |
| 6 | ESLint ban on importing the raw client outside `lib/data/` | Routes bypassing the boundary |

## Consequences

**Positive.** One authoritative isolation mechanism, enforced by the database and unbypassable
by application bugs. Clean separation: isolation is data-level, authorization is
application-level. No duplicated predicates to drift out of sync. RLS overhead is ~1–5%
because the planner pushes policy predicates into index scans, so the redundant filter would
not have bought performance either.

**Negative / accepted.** Every tenant call site becomes `withOrg(ctx, tx => …)` rather than a
bare client call — more ceremony, and the tenant boundary is lexically visible (which is also
an auditability gain). Every request holds an interactive transaction for its duration; the
spike showed 20 concurrent calls against a pool of 5 queueing cleanly (~430 ms, no timeouts),
but that was a synthetic 100 ms hold, not a production traffic model. Prisma's transaction
`timeout` and `maxWait` defaults become load-bearing and must be pinned explicitly.

**Risks recorded in `DEFERRED_REGISTER.md`:** production pool sizing (D-040), the non-tenant
data path (D-041).

## Alternatives rejected

- **Application-level `where: { orgId }` in addition to RLS.** Rejected: duplicates a filter
  RLS already owns, drifts, and inverts the separation of concerns. AWS Prescriptive Guidance
  states RLS "removes the burden of maintaining this isolation from software developers."
- **An args-injecting wrapper** (what `$extends` was meant to be, at the args level).
  Rejected: unproven, and "automatic" is exactly what made the `$extends` failure invisible —
  it looked scoped, raised no error, and silently returned nothing.
- **Repository layer up front.** Rejected as pass-through indirection with no logic to hold.

## References

- [AWS Prescriptive Guidance — multi-tenant SaaS on managed PostgreSQL](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/best-practices.html)
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Supabase — enable RLS by default on new tables](https://github.com/orgs/supabase/discussions/21747)
- Task-0/0b spike: `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`
