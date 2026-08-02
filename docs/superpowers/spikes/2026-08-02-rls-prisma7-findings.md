# Spike findings: Postgres RLS + Prisma 7 `$extends` — Task 0

**Date:** 2026-08-02
**Branch:** `phase1a-isolation-spine`
**Time-box:** 5 working days (elapsed: well under 1 day of effort)

## Verdict: **NO-GO**

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
