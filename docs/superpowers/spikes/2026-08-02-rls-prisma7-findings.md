# Spike findings: Postgres RLS + Prisma 7 `$extends` — Task 0

**Date:** 2026-08-02
**Branch:** `phase1a-isolation-spine`
**Time-box:** 5 working days (elapsed: well under 1 day of effort)

## Verdict (combined, see Task 0b below for the second half)

- **`$extends` / `$allOperations` wrapper: NO-GO.** (Task 0, this section.)
- **`withOrg` explicit-transaction-handle pattern: GO.** (Task 0b, appended
  below — probed separately after the human ruling that a NO-GO on `$extends`
  does not mean surrendering RLS as defence-in-depth.)

These are two different mechanisms, not two results for the same one. The
distinction matters: the spec's Tasks 3/6 assumed `$extends` specifically;
that assumption is dead, but Postgres RLS itself, and a viable way to drive
it from Prisma 7, are both alive. See "Task 0b" at the end of this document
for the full second verdict before drawing conclusions from this section
alone.

## Task 0 verdict: **NO-GO** (for `$extends` specifically)

The exact mechanism specified in the task brief — wrapping every Prisma operation
in an interactive transaction via `PrismaClient.$extends({ query: { $allModels:
{ $allOperations } } })`, calling `tx.$executeRaw` to set the org GUC and then
`query(args)` to run the actual operation — **does not propagate the GUC to the
operation it wraps.** PROBE A returned 0 rows instead of the expected 1. This is
the single load-bearing mechanic Tasks 3 and 6 were to be built on, so this is a
hard NO-GO for that approach as written.

The good news: the failure mode is fail-closed (0 rows, not the wrong org's
rows, and no thrown error), and directly using `tx.<model>.<op>()` on a
manually-opened interactive transaction (PROBE D pattern) **does** correctly
propagate the GUC. See "Root cause" below — there is a viable path forward
that isn't the one this spike was scoped to test.

## Versions

```
$ npx prisma --version
prisma               : 7.8.0
@prisma/client       : 7.8.0
Operating System     : linux
Architecture         : x64
Node.js              : v22.22.3
TypeScript           : 5.9.3
Query Compiler       : enabled
PSL                  : @prisma/prisma-schema-wasm 7.8.0-6.3c6e192761c0362d496ed980de936e2f3cebcd3a
Schema Engine        : schema-engine-cli 3c6e192761c0362d496ed980de936e2f3cebcd3a
Studio               : 0.27.3

$ docker exec docker-postgres-1 psql -U makrai -d postgres -c "SELECT version();"
PostgreSQL 16.14 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit

$ docker exec docker-postgres-1 postgres --version
postgres (PostgreSQL) 16.14
```

## Deviation from the brief required to get the probe running at all

Prisma 7.8.0 removed the schema-file `datasource { url }` field and the
`PrismaClient({ datasourceUrl })` constructor option entirely
(error `P1012: The datasource property 'url' is no longer supported in schema
files`). `PrismaClient` now requires a driver `adapter`. This matches how the
app's own `lib/db.ts` is already built (`@prisma/adapter-pg` + `pg.Pool`), so
the spike client was constructed the same way:

```ts
const adapter = new PrismaPg(APP_URL); // APP_URL = spike_app connection string
const base = new PrismaClient({ adapter });
```

This is a mechanical adaptation only — the `$extends`/`$allOperations`/
`set_config` logic under test is unchanged from the brief. Recorded here
because **every later task that constructs a `PrismaClient` needs to know
`datasourceUrl` is gone in Prisma 7** — this is a real, generally-applicable
finding, not spike-specific trivia.

## Probe output (verbatim)

Single run, `npx tsx spike/rls-prisma7/probe.ts`:

```json
{
  "A_scoped_row_count": 0,
  "A_scoped_labels": [],
  "B_unscoped_row_count": 0,
  "B_threw": false,
  "C_cross_org_write_allowed": false,
  "D_nested_write_ok": true
}
```

Expected for GO (per brief):
```
A_scoped_row_count: 1
A_scoped_labels: ["org-A widget"]
B_unscoped_row_count: 0
B_threw: false
C_cross_org_write_allowed: false
```

| Probe | Expected | Actual | Result |
|---|---|---|---|
| A — scoped client sees only its own org | `1`, `["org-A widget"]` | `0`, `[]` | **FAIL** |
| B — no GUC set ⇒ 0 rows, no throw (fail-closed) | `0 rows`, `threw: false` | `0 rows`, `threw: false` | Pass (but see note below — this pass is a side-effect of A's failure, not independent confirmation) |
| C — cross-org write refused by `WITH CHECK` | `false` | `false` | Pass (same caveat as B) |
| D — nested write inside a manually-opened transaction | `true` | `true` | **Pass — and this is the important positive result** |

**Important caveat on B and C:** because PROBE A shows the GUC is never
reaching the connection the query actually runs on, the org context is
*always* absent for every operation dispatched via `$allOperations` →
`query(args)`, not just when the brief intends it to be absent. B and C
"passing" is consistent with correct fail-closed behavior, but it is also
exactly what you'd see if scoping never worked at all — the two are not
distinguishable from B and C alone. PROBE A is what falsifies the mechanism,
and it does.

## Root cause (diagnosed, not fixed — per task ambiguity ruling #3, the
policy/mechanism was not altered to force a pass)

Added a temporary diagnostic (`spike/rls-prisma7/diagnose.ts`, deleted with
the rest of `spike/` in Step 8) that checked `pg_backend_pid()` and
`current_setting('app.current_org_id', true)` from inside the `tx` callback,
immediately before calling `query(args)`:

```
base client pid (separate call)= 103240
inside tx: pid= 103240 setting-on-tx= 11111111-1111-1111-1111-111111111111
rows via db.widget.findMany() = []
```

The GUC is correctly set and readable *from `tx` itself* right up until
`query(args)` is invoked (same backend PID, confirming it's not a distinct
physical connection at that instant). But `findMany()` still returns `[]`.
`set_config(..., true)` is `SET LOCAL` semantics — scoped to the enclosing
transaction. The `query(args)` function passed into an `$allOperations` hook
is bound to the *extension's underlying client* (`base`), not to the ambient
`tx` — it is not automatically rebound to run inside the `$transaction`
callback that invoked it, even though it is *called* lexically inside that
callback. The practical effect: by the time the actual `SELECT` for
`findMany()` is dispatched, it is not running inside the transaction that
set the GUC, so `current_setting` reverts to unset, and the `NULLIF` guard
correctly (fail-closed) returns zero rows.

This is corroborated by PROBE D: when `tx.widget.create(...)` is called
*directly* on a manually-opened `db.$transaction(async (tx) => {...})` — with
no `query(args)` indirection in between — the write succeeds and satisfies
`WITH CHECK`, proving the GUC *does* propagate correctly to operations called
directly on `tx`. The bug is specific to the `$allOperations({ query }) =>
base.$transaction(tx => query(args))` composition pattern, not to
`set_config`/`NULLIF`/RLS itself.

## Concurrency probe (Step 5)

Two probe processes run concurrently against the same role/database:

```bash
npx tsx spike/rls-prisma7/probe.ts & npx tsx spike/rls-prisma7/probe.ts & wait
```

Run 1:
```json
{
  "A_scoped_row_count": 0,
  "A_scoped_labels": [],
  "B_unscoped_row_count": 0,
  "B_threw": false,
  "C_cross_org_write_allowed": false,
  "D_nested_write_ok": true
}
```

Run 2:
```json
{
  "A_scoped_row_count": 0,
  "A_scoped_labels": [],
  "B_unscoped_row_count": 0,
  "B_threw": false,
  "C_cross_org_write_allowed": false,
  "D_nested_write_ok": true
}
```

Neither run reported `2` (no cross-run leak), but neither reported the
expected `1` either — consistent with PROBE A's finding that this composition
never carries the GUC into the wrapped operation, concurrent or not. The
concurrency probe therefore does not add new information beyond confirming
the single-run result is stable: this is a structural failure of the wrapper
pattern, not a flaky pooling race.

## What Prisma 7.8 `$extends` behavior later tasks need to know

1. **`datasourceUrl` is gone.** `PrismaClient` requires an `adapter`
   (`@prisma/adapter-pg` + `pg.Pool`, matching `lib/db.ts`).
2. **`base.$transaction(async (tx) => { ...; return query(args); })` inside an
   `$allModels.$allOperations` hook does NOT run `query(args)` inside `tx`.**
   The GUC set via `tx.$executeRaw` is invisible to the wrapped operation.
   Do not build the production data layer on this exact composition — it
   silently fails closed (returns nothing / rejects all writes) rather than
   leaking data, which is the best-case failure mode for a security bug, but
   it means org-scoped reads/writes never work at all, not just under an
   attack.
3. **Calling model operations directly on an interactive-transaction handle
   (`tx.widget.create(...)`, not `query(args)` inside an extension) correctly
   sees a GUC set via `tx.$executeRaw` earlier in the same transaction.**
   This is a genuine, verified-working alternative shape: an explicit
   "runInOrgContext(orgId, async (tx) => {...})" helper that opens the
   transaction, sets the GUC, and hands the caller `tx` to operate on
   directly — no `$extends`/`$allOperations` involved — appears to work,
   based on PROBE D. This was **not** exhaustively probed (only one write
   was tested) and was **not** in this spike's scope to design or verify as
   a replacement; it is recorded here as a lead for whoever designs the
   fallback data layer, not as a verified interface.
4. Prisma 7's own official extension examples elsewhere use
   `prisma.$transaction([rawSetConfig, query(args)])` — the *array/batch*
   form of `$transaction`, not the interactive-callback form the brief
   specifies. That form was not tested in this spike (the brief is explicit
   about using the literal probe as written, and ambiguity ruling #3
   direct not to "fix" a failing probe by changing the mechanism under
   test). It may or may not sidestep this bug; that is a candidate follow-up,
   not a finding of this spike.

## Verdict rationale

Per task ambiguity ruling #2/#3 style guidance ("record plainly rather than
trying to fix it; redesigning the mechanism is out of scope for this task")
and rule 5 ("Report honest results... A NO-GO verdict is a completely
acceptable and valuable outcome"): PROBE A is the primary pass/fail gate for
the `$extends` mechanism this spike exists to de-risk, and it failed. This is
**NO-GO** for the `$allOperations` + interactive-transaction-callback +
`query(args)` composition as specified in the task brief and in the spec's
Tasks 3/6 interface assumption.

## Disposition

- Tasks 3 and 4 (which depend on the `$extends` mechanism as specified) are
  dropped per Step 9 of the brief.
- `docs/DEFERRED_REGISTER.md` row D-005 updated to `Scheduled` in the same
  commit as this document, citing this finding as the trigger and Task 3's
  redesign (informed by the PROBE D lead above) as the target.
- Proceeding to Task 1 with the scoped data layer as the sole runtime guard,
  per the brief's Step 9 NO-GO branch.

---

# Task 0b — `withOrg` pattern

**Date:** 2026-08-02 (same day, continuation of the time-box after the
`$extends` NO-GO)
**Ruling that authorized this continuation:** the `$extends` NO-GO does not
mean surrendering RLS as defence-in-depth — Task 0's own findings said the
failure was in the `$extends` composition, not in `set_config`/`NULLIF`/RLS
itself. This task probes the PROBE D lead from Task 0 properly, as a
standalone candidate production mechanism, rather than as an unverified
aside.

## Task 0b verdict: **GO**

```ts
async function withOrg<T>(orgId: string, cb: (tx) => Promise<T>): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return cb(tx);
  });
}
```

One interactive transaction per call, GUC set inside it, caller operates
directly on the `tx` handle (no `$extends`, no `$allOperations`, no
`query(args)` indirection). All 9 probes passed, including the nested-write
case that broke `$extends`, and the pool-behaviour probe — the item flagged
as needing "a real answer" — showed clean queuing with no timeouts, no
rejections, and no deadlocks under 20 concurrent transactions against a
5-connection pool.

## Environment (identical to Task 0, rebuilt)

Same `makrai_spike` database, same `spike_app` role (non-superuser,
`NOBYPASSRLS`), same `widgets` table with `FORCE ROW LEVEL SECURITY` and the
exact `NULLIF` policy. Added one child table for the nested-write probe:

```sql
CREATE TABLE widget_parts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL,
  widget_id uuid NOT NULL REFERENCES widgets(id),
  name      text NOT NULL
);

ALTER TABLE widget_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_parts FORCE  ROW LEVEL SECURITY;

CREATE POLICY widget_parts_org_isolation ON widget_parts
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON widget_parts TO spike_app;
```

Seed rows given fixed UUIDs (`aaaaaaaa…` for the org-A widget, `bbbbbbbb…`
for the org-B widget) so probe 2 could do a cross-org `findUnique`-by-id
lookup deterministically. Same `PrismaPg` + `pg.Pool` adapter pattern as
Task 0 (`datasourceUrl` is gone in Prisma 7.8, confirmed again).

Prisma / Postgres versions: identical to Task 0 — `prisma 7.8.0` /
`@prisma/client 7.8.0` / `PostgreSQL 16.14` (Alpine, in `docker-postgres-1`).

## Probe output (verbatim, first run)

```json
{
  "P1_scoped_read_count": 1,
  "P1_scoped_read_labels": [
    "org-A widget"
  ],
  "P2_cross_org_read_by_id": null,
  "P3_scoped_write_ok": true,
  "P3_created_id": "62bfb21e-7984-44e7-9dff-f93b00ceb90a",
  "P4_cross_org_write_allowed": false,
  "P4_error": "new row violates row-level security policy for table \"widgets\"",
  "P5_nested_write_ok": true,
  "P5_parts_created": 2,
  "P6_raw_query_count": 3,
  "P7_concurrency_results": [
    { "i": 0, "org": "11111111-1111-1111-1111-111111111111", "count": 3, "labels": ["org-A widget", "p3-scoped-write", "p5-parent"] },
    { "i": 1, "org": "22222222-2222-2222-2222-222222222222", "count": 1, "labels": ["org-B widget"] },
    { "i": 2, "org": "11111111-1111-1111-1111-111111111111", "count": 3, "labels": ["org-A widget", "p3-scoped-write", "p5-parent"] },
    { "i": 3, "org": "22222222-2222-2222-2222-222222222222", "count": 1, "labels": ["org-B widget"] },
    { "i": 4, "org": "11111111-1111-1111-1111-111111111111", "count": 3, "labels": ["org-A widget", "p3-scoped-write", "p5-parent"] },
    { "i": 5, "org": "22222222-2222-2222-2222-222222222222", "count": 1, "labels": ["org-B widget"] },
    { "i": 6, "org": "11111111-1111-1111-1111-111111111111", "count": 3, "labels": ["org-A widget", "p3-scoped-write", "p5-parent"] },
    { "i": 7, "org": "22222222-2222-2222-2222-222222222222", "count": 1, "labels": ["org-B widget"] },
    { "i": 8, "org": "11111111-1111-1111-1111-111111111111", "count": 3, "labels": ["org-A widget", "p3-scoped-write", "p5-parent"] },
    { "i": 9, "org": "22222222-2222-2222-2222-222222222222", "count": 1, "labels": ["org-B widget"] }
  ],
  "P7_leak_detected": false,
  "P7_leaked_calls": [],
  "P9_unscoped_row_count": 0,
  "P9_threw": false
}
{
  "P8_pool_max": 5,
  "P8_concurrent_calls": 20,
  "P8_wall_time_ms": 430,
  "P8_fulfilled": 20,
  "P8_rejected": 0,
  "P8_rejection_messages": []
}
```

Re-run twice more for determinism (leak detection and pool behaviour are
exactly the properties that must not be a one-off pass):

| Run | P1 count (grows — P3/P5 write each run) | P7 leak detected | P8 fulfilled/rejected | P8 wall time |
|---|---|---|---|---|
| 1 | 1 | false | 20 / 0 | 430 ms |
| 2 | 3 | false | 20 / 0 | 428 ms |
| 3 | 5 | false | 20 / 0 | 429 ms |

Stable across all three runs.

## Per-probe results

| # | Probe | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Scoped read (`tx.widget.findMany()` inside `withOrg(ORG_A)`) | 1 row, `["org-A widget"]` | 1 row, `["org-A widget"]` | **PASS** |
| 2 | Cross-org read by id (`findUnique` on org-B's row inside `withOrg(ORG_A)`) | `null` | `null` | **PASS** |
| 3 | Scoped write (`create` with `orgId: ORG_A` inside `withOrg(ORG_A)`) | succeeds | succeeded | **PASS** |
| 4 | Cross-org write refused (`create` with `orgId: ORG_B` inside `withOrg(ORG_A)`) | rejected by `WITH CHECK` | rejected — `"new row violates row-level security policy for table \"widgets\""` | **PASS** |
| 5 | Nested write (`widget.create` with nested `parts: { create: [...] }`) | child rows carry the GUC | 2/2 child rows created | **PASS** |
| 6 | Raw query inside callback (`tx.$queryRaw`) | respects GUC | returned org-scoped count (3, matching org-A's rows at that point) | **PASS** |
| 7 | Concurrency (10 interleaved `withOrg` calls, alternating org) | every call sees only its own org | zero leaks across 3 runs | **PASS** |
| 8 | Pool behaviour (`Pool({ max: 5 })`, 20 concurrent `withOrg` calls, query + `pg_sleep(0.1)` each) | queue cleanly or report timeout/deadlock | queued cleanly: 20/20 fulfilled, 0 rejected, ~430 ms wall time, no errors, across 3 runs | **PASS** |
| 9 | Fail-closed outside (`base.widget.findMany()` with no `withOrg`) | 0 rows, no throw | 0 rows, no throw | **PASS** |

All 9 probes passed. No root-cause diagnosis needed — nothing failed.

## Read on probe 8 (the coordinator's specific question)

**Acceptable for a per-request transaction in production, based on this
spike.** 20 concurrent `withOrg` calls against a 5-connection pool — each
call holding its connection for a query plus a 100 ms artificial hold —
completed in ~430 ms with zero rejections, zero timeouts, and no deadlock,
consistently across 3 runs. The math checks out: 20 calls over a
5-connection pool is 4 sequential batches; at roughly 100 ms of held-connection
time per call (dominated by the `pg_sleep`) that's ~400 ms of unavoidable
serialization, which is what was observed — the queuing overhead itself
looks negligible. Prisma's default interactive-transaction `maxWait` (time to
acquire a connection before giving up — 2000 ms by default) and `timeout`
(max transaction lifetime — 5000 ms by default) were never approached, let
alone tripped; no `P2028` or similar timeout error appeared in any run.

Caveats on generalizing this to production capacity planning, stated
explicitly because the spike does not cover them:
- 100 ms is an artificial, uniform hold time. Real request handlers have a
  much wider and generally longer distribution (application logic between
  the `set_config` and the query, network round-trips, etc.), and if p99
  hold time rises, queuing delay rises faster than linearly as the pool
  saturates — this spike only demonstrates the mechanism *can* queue safely
  under modest load, not what pool size a given production request volume
  needs.
- Real workloads are not 100% concurrent-write/read-holding-a-transaction;
  a mix of one-shot queries and grouped writes will behave differently.
- Pool size (5) and burst size (20) here are illustrative, not derived from
  any production traffic model. Sizing the real pool is a follow-up decision
  for whoever builds Task 3's data layer, not answered by this spike.

None of these caveats point to a problem with the mechanism itself — they're
the boundary of what a 20-call, 430 ms spike can responsibly claim. If
anything, the fact that nothing needed tuning to pass cleanly at this scale
is a mildly positive signal for the "one interactive transaction per
request" shape being production-viable, not just spike-viable.

## What this changes for Task 3 / the data layer redesign

- The `withOrg`-style explicit-transaction-handle pattern is now a
  **verified** mechanism (not just a lead), covering scoped reads, scoped
  writes, cross-org write rejection, nested writes across a parent/child
  table pair, raw queries, and concurrent use against a small pool — all
  under the real `spike_app` role with `FORCE ROW LEVEL SECURITY`.
- Consequence for API ergonomics: every data-access call site in the app
  must go through something shaped like `withOrg(orgId, (tx) => ...)` rather
  than calling `prisma.<model>.<op>()` directly — there is no drop-in
  `$extends`-based transparent wrapper that achieves the same guarantee (that
  path is closed per Task 0). This is a real cost (every call site is
  touched) versus the `$extends` vision (existing call sites unchanged) —
  worth naming plainly for whoever scopes Task 3's redesign effort.
- RLS itself remains sound as defence-in-depth; the NO-GO from Task 0 was
  about a specific Prisma composition, not about Postgres RLS or the
  `NULLIF` policy shape, both of which continue to test cleanly (probes 2,
  4, and 9 here again confirm fail-closed and `WITH CHECK` enforcement,
  independent of `$extends`).

## Disposition (Task 0b)

- D-005 in `docs/DEFERRED_REGISTER.md` updated again: still `Scheduled`
  (Task 3 redesign is still pending), but now pointing at a verified
  `withOrg` mechanism instead of an unverified lead, with the API-ergonomics
  cost noted above.
- `spike/` torn down again the same way as Task 0: `makrai_spike` dropped,
  `spike_app` role dropped, `spike/` directory removed. Only this findings
  document and the register update are committed.
