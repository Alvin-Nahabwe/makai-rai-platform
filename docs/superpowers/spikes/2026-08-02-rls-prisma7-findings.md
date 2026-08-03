# Task 0 spike — Postgres RLS through Prisma 7.8

**Date:** 2026-08-02 · **Verdict: GO for `withOrg`, NO-GO for `$extends`**
**Status:** re-derived from scratch after the Phase-1a rollback (register D-063). An earlier
spike reached a similar verdict; its findings were discarded unread before this run so that
this is a re-derivation and not a transcription.

## Why the earlier spike's verdict was not reusable

Its fixture was `widgets (id uuid, org_id uuid, label text)` — snake_case, `uuid`. The real
tenant tables are `projects ("orgId" text, …)` — snake_case table, **quoted camelCase column,
`text` type**. RLS was therefore proven against a schema shape the application does not have,
which is why it returned GO and the real migration later failed outright with
`operator does not exist: text = uuid`.

**This spike's fixture mirrors the real shape** (`spike/rls-prisma7/setup.sql`). A verdict from
a non-representative fixture does not transfer.

## What the spike had to prove (STRIDE, via `engineering-skills:senior-security`)

Derived from the tenant data-store and data-flow elements, rather than inherited as a probe list.

| Threat | Obligation |
|---|---|
| Information disclosure | no context → 0 rows *and no error*; cross-org read; cross-org fetch **by primary key** |
| Tampering | cross-org INSERT and UPDATE rejected (`WITH CHECK`, not `USING` alone) |
| Elevation of privilege | app role `NOSUPERUSER NOBYPASSRLS`, not the table owner |
| Information disclosure (data flow) | **GUC residue on a reused pooled connection** |
| Denial of service | transaction-per-request against a bounded pool |

## Results

SQL level, connected as `spike_app` (`NOSUPERUSER NOBYPASSRLS`):

| # | Probe | Result |
|---|---|---|
| 1 | no GUC | **0 rows, no error** — fails closed |
| 2 | GUC = org-A | only org-A's row |
| 3 | fetch org-B by primary key while scoped to org-A | **0** |
| 4 | cross-org INSERT | `ERROR: new row violates row-level security policy` |
| 5 | cross-org UPDATE (move own row to another org) | same rejection |

Prisma 7.8 level (`spike/rls-prisma7/probe.ts`):

| # | Probe | Result | Verdict |
|---|---|---|---|
| A | `$extends({$allModels.$allOperations})` wrapping ops in `base.$transaction` | **0 rows, expected 1** | **NO-GO** |
| B | no context via the plain client | 0 rows, no throw | fails closed |
| C | `withOrg` — one interactive tx, callback receives the `tx` handle | 1 row, correct | **GO** |
| D | cross-org `findUnique` by id | `null` | no IDOR |
| E | cross-org `create` | rejected — `RLS WITH CHECK` | tampering blocked |
| F | **reused pooled connection (`max: 1`)** | GUC reads `<unset>`; 0 rows visible | **no leakage** |
| G | 10 concurrent interleaved `withOrg` calls, alternating orgs | 0 mismatches | no cross-contamination |

## Why `$extends` fails

The `$allOperations` hook receives `query`, which is already bound to the **base client**. Calling
it inside `base.$transaction(...)` does not re-bind it to the ambient transaction, so
`set_config` and the query execute on **different pooled connections**. The failure is
fail-closed (0 rows, silent) rather than a leak — which is precisely what makes it dangerous:
it looks scoped, raises nothing, and returns nothing.

`withOrg` avoids this by never hiding the transaction: the callback is handed the `tx` handle
and every query inside it demonstrably runs on that connection.

## Prisma 7 breaking changes re-derived from the toolchain

- `datasource.url` in a schema file is **rejected** (P1012). The URL belongs in a Prisma config;
  `PrismaClient` takes an `adapter`. (The app's own `lib/db.ts` already does this.)
- There is no `datasourceUrl` constructor option; construct with
  `new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString })) })`.

## Consequences to carry into ADR-0001

1. **Adopt `withOrg`; reject `$extends`.** There is no transparent wrapper — every tenant call
   site becomes `withOrg(ctx, tx => …)`. That ergonomic cost is the price of the mechanism
   actually working, and it makes the tenant boundary lexically visible.
2. **State the failure-mode argument explicitly.** App-layer `where: { orgId }` fails by
   *omission* (one missing clause = silent leak — the IDOR class that motivated this rebuild);
   RLS fails by *misconfiguration*, which is enumerable and testable. That asymmetry, not
   performance, is the case for RLS.
3. **A superuser bypass cannot be closed at the database layer.** `FORCE` binds a non-superuser
   *owner*; it does nothing to a superuser. Containing `makrai` is an architectural claim about
   role separation that the ADR must make explicitly — not a property RLS provides.
4. **Identifier convention is load-bearing** (D-064). Any DDL-introspecting SQL must resolve
   columns via catalog/OID lookups, never by reconstructing a name from `object_identity`.
5. **Transaction-per-request couples isolation to pool behaviour**, and hosting is still parked
   (D-018). Probe G used trivial queries, not a traffic model — see D-065.

## Not proven here

- Real-workload pool sizing. Probe G ran 10 trivial concurrent queries; that is not a traffic
  model, and Prisma's transaction `timeout`/`maxWait` defaults become load-bearing under this
  design (D-065).
- Behaviour behind an external connection pooler (PgBouncer transaction vs session mode), which
  depends on the parked hosting decision (D-018).
- Anything in a browser. This is a database-level spike only.
