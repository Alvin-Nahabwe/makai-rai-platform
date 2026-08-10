# Phase 1d-i — Put the e2e suite on the gate: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the end-to-end suite on the required status check — minus one named, quarantined spec — so live browser verification is enforced by machine before Phase 1d-ii lands changes only a browser test can see.

**Architecture:** Six independent units, ordered by hard dependency rather than by register-row number. The suite must first become *collectable* on a cold checkout (Task 1) before any CI job can run it; the known flake is *quarantined* rather than fixed (Task 2), which deletes the statistical promotion threshold entirely; the live third-party call is removed (Task 3) so CI needs no email secret; a production defect the e2e surfaced is ruled on and fixed (Task 4); the job is added (Task 5); and only then is the check promoted, with a demotion path (Task 6). D-185's investigation (Task 7) is decoupled and blocks nothing.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts` not middleware) · React 19.2.4 (StrictMode on) · Prisma 7.8 + pg adapter · next-auth 5.0.0-beta.31 · Postgres 16 (RLS + FORCE) · vitest 4.1.9 (`fileParallelism: false`) · Playwright (9 spec files, 49 tests, `fullyParallel: false`, 6 workers on 12 CPUs, `retries: 2` CI / `0` local) · GitHub Actions

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22 is canonical.** `.nvmrc` is the single source; `__tests__/lint/node-version-alignment.test.ts` fails if any declaration site diverges.
- **`main` is GATED.** Required check `lint, typecheck, test, build`; `enforce_admins: true`; `required_pull_request_reviews: null`. Every change lands via branch → PR → green CI. **Direct pushes to `main` are rejected** (`GH006`).
- **Tenant data ONLY through `withOrg(ctx, cb)`**; non-tenant through `identityDb`. App code may not import `lib/db` or `lib/auth` — ESLint-enforced and pinned by `__tests__/lint/effective-config.test.ts`.
- **Every guard proven non-vacuous** by reverting it and watching the test go red. **And per D-191:** state the obligation's PROPERTY in your own words, state what the test actually CAUSES, then ask whether the second entails the first. A test that greps for a mechanism does **not** discharge an obligation — a guard on the wrong surface satisfies a grep exactly.
- **Where a list must be complete, GENERATE it from disk** rather than writing it (AGENTS.md §3).
- **Every conscious not-doing gets a `docs/DEFERRED_REGISTER.md` row in the SAME commit** (§6). The register is at 196 rows; each row is exactly 10 pipe-delimited fields. A scripted append has broken this three times. **After any register edit run:** `awk -F'|' 'NR>2 && NF>1 && NF!=10 {print NR": "NF}' docs/DEFERRED_REGISTER.md` — output must be empty for `D-` rows.
- **Do not put a literal `|` inside any register cell.** It breaks the row silently.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `.github/workflows/ci.yml` | add a `test-e2e` job; nothing else changes | 1, 5 |
| `e2e/assessment-flow.spec.ts` | quarantine marker only | 2 |
| `playwright.config.ts` | `webServer.env` (Task 3) and `webServer.command` (Task 1). **Ownership is per key** — Task 1 owns `command`, Task 3 owns `env`. Neither rewrites the other's key. | 1, 3 |
| `e2e/two-orgs.spec.ts` | discriminating assertions for the invite flow | 3 |
| `__tests__/integration/invite-email-failure.test.ts` | **new** — O-7, the 201-with-`acceptUrl` path that has zero coverage today | 3 |
| `lib/rate-limit.ts` | the registration cap, pending the Task 4 ruling | 4 |
| `__tests__/integration/rate-limit-headroom.test.ts` | **new** — O-10, generated from `RATE_LIMITS`, not hard-coded | 4 |
| `e2e/fixtures/instrumentation.ts` | **new** — harness-only D-185 capture; imports nothing from `app/`, `lib/`, `components/` | 7 |
| `docs/DEFERRED_REGISTER.md` | row updates, same commit as the change each describes | all |

**No file under `app/`, `lib/` (except `lib/rate-limit.ts` in Task 4), or `components/` is modified by this plan.** If a task finds itself editing one, that is the §2 "touching a file the brief did not name" trigger — stop and report.

---

## Task 1: Make the suite collectable on a cold checkout, and let Playwright own the server

**Why first:** every later task that runs the suite in CI depends on this. It is currently impossible — verified by reproduction, not inference.

**Files:**
- Modify: `playwright.config.ts` (the `webServer.command` key only)
- Modify: `.github/workflows/ci.yml` (nothing yet — Task 5 adds the job; this task only proves the mechanism)

**Interfaces:**
- Produces: the two-invocation pattern Task 5's job depends on, and an environment-dependent `webServer.command`.

- [ ] **Step 1: Reproduce the defect (this is the RED)**

```bash
mv e2e/fixtures/.auth /tmp/auth-backup
npx playwright test --list ; echo "exit=$?"
mv /tmp/auth-backup e2e/fixtures/.auth
```

Expected: **non-zero exit**, with `Error: ENOENT ... e2e/fixtures/.auth/manifest.json at two-orgs.spec.ts:33`.

Why it happens: four specs read the manifest at **module scope** — `assessment-flow.spec.ts:33`, `evidence-lifecycle.spec.ts:26`, `two-orgs.spec.ts:33`, `role-matrix.spec.ts:50` — the file is gitignored (`.gitignore:53`), and `dependencies: ['setup']` orders **execution**, not **loading**.

- [ ] **Step 2: Confirm the repair mechanism works**

```bash
mv e2e/fixtures/.auth /tmp/auth-backup
npx playwright test --project=setup --list ; echo "exit=$?"
mv /tmp/auth-backup e2e/fixtures/.auth
```

Expected: **exit 0**, `Total: 1 test in 1 file`. Playwright filters by project *during collection*, so the other spec modules are never loaded. **This is why no source refactor is needed** — do not rewrite the four specs to lazy-load; that would churn four files and risk `two-orgs.spec.ts`'s generated test titles for no gain.

- [ ] **Step 3: Make `webServer.command` environment-dependent**

Playwright must own the server. The CI job must **not** run `next start &` itself: with `reuseExistingServer: !process.env.CI` (false in CI), Playwright throws on an occupied port — `node_modules/playwright/lib/runner/index.js:821-827`:

```js
if (isAlreadyAvailable) {
  if (this._options.reuseExistingServer) return;
  throw new Error(`... is already used, make sure that nothing is running on the port/url
                   or set reuseExistingServer:true in config.webServer.`);
}
```

Setting `reuseExistingServer: true` to dodge that would make Task 3's `webServer.env` **dead code**, silently deleting its mechanism. So:

```ts
webServer: {
  // CI serves the production build; local development keeps the dev server.
  // Playwright OWNS this process in both cases -- the CI job must never
  // start its own, or the port check above throws (verified at
  // node_modules/playwright/lib/runner/index.js:821-827).
  command: process.env.CI ? 'npm run start' : 'npm run dev',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
},
```

- [ ] **Step 4: Verify the local path is unchanged**

```bash
npx playwright test --list
```
Expected: `Total: 49 tests in 9 files` — same as before. This task must not change local behaviour.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts
git commit -m "fix(1d-i): Playwright owns the server; CI serves the production build

Verified by reproduction, not inference: with the fixture manifest moved
aside, 'npx playwright test --list' exits non-zero with ENOENT at
two-orgs.spec.ts:33 -- four specs read a gitignored file at module scope and
dependencies:['setup'] orders execution, not loading. 'npx playwright test
--project=setup --list' exits 0 with 1 test in 1 file, so project filtering
applies during collection. Task 5's job uses that two-invocation pattern; no
spec source needs to change.

webServer.command is now environment-dependent so Playwright owns the server
in CI too. The job must not run 'next start &' itself: reuseExistingServer is
false in CI and Playwright throws on an occupied port
(node_modules/playwright/lib/runner/index.js:821-827). Setting
reuseExistingServer:true instead would make Task 3's webServer.env dead code."
```

---

## Task 2: Quarantine the D-185 flake

**Files:**
- Modify: `e2e/assessment-flow.spec.ts:48`
- Modify: `docs/DEFERRED_REGISTER.md` (D-185)

**Read this before starting.** `assessment-flow.spec.ts` contains exactly **one** test — line 48, `'create, answer, complete, view report, download PDF'`. Quarantining it removes the **entire assessment happy path** from CI, including the PDF download, not a minor edge case. That cost is the price of the gate existing at all, and it must be written into the register row rather than glossed.

- [ ] **Step 1: Mark it, with a reason**

```ts
test.fixme(
  'create, answer, complete, view report, download PDF',
  async ({ page }) => {
```

Use `test.fixme`, **not** `test.skip` behind a conditional: `fixme` is listed in every run's output as expected-to-fail, so the quarantine stays visible. A conditional skip satisfies "not red" while hiding that coverage is gone — which is the silence `ci.yml:226` explicitly rules out ("Playwright's own retry/annotation mechanism, **not silence**").

- [ ] **Step 2: Verify it is reported, not hidden**

```bash
npx playwright test e2e/assessment-flow.spec.ts 2>&1 | tail -5
```
Expected: the run passes and the output names the test as skipped/fixme. **PROPERTY vs MECHANISM check (D-191):** the property is *"the flake cannot redden the gate AND its absence stays visible"*. The mechanism is `test.fixme`. Passing entails the first clause; the second is entailed only because `fixme` prints. Confirm the name actually appears in the output — do not infer it.

- [ ] **Step 3: Update D-185 with the quarantine and its cost**

The row must state: the test is quarantined, the mechanism (`test.fixme`), that the **entire assessment happy path including PDF download** now has no CI coverage, and that the pick-up trigger is Task 7's investigation.

- [ ] **Step 4: Register integrity**

```bash
awk -F'|' 'NR>2 && NF>1 && NF!=10 {id=$2; gsub(/[* \t]/,"",id); if (id ~ /^D-[0-9]/) print NR": NF="NF}' docs/DEFERRED_REGISTER.md
```
Expected: empty.

- [ ] **Step 5: Commit** (spec + register together, per §6)

---

## Task 3: D-188 — remove the live Resend call, with assertions that discriminate

**Files:**
- Modify: `playwright.config.ts` (the `webServer.env` key only — Task 1 owns `command`)
- Modify: `e2e/two-orgs.spec.ts` (the invite assertions, around `:92-95`)
- Create: `__tests__/integration/invite-email-failure.test.ts` (O-7)
- Modify: `docs/DEFERRED_REGISTER.md` (D-188)

**Interfaces:**
- Consumes: Task 1's `webServer` block.
- Produces: an invitation e2e that makes no third-party network call, so Task 5's job needs no `RESEND_API_KEY`.

**Two facts, both executed rather than assumed:**
1. Playwright **merges** `env` over `process.env` — `runner/index.js:834-838`: `env: { ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...this._options.env }`. Had it replaced, blanking one key would strip `DATABASE_URL`.
2. An empty-string `RESEND_API_KEY` **survives** Next's `.env` load (`@next/env` does not overwrite an already-defined key, even an empty one), and `send.ts:32-37` throws on it **before** `new Resend()` is constructed — so no client exists and no network call is possible.

- [ ] **Step 1: Blank the key**

```ts
webServer: {
  command: process.env.CI ? 'npm run start' : 'npm run dev',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
  // D-188. The invite POST used to make a live call to Resend, whose sandbox
  // rejects the fixture's synthetic recipient -- slow and nondeterministic
  // against a 5s expect timeout under 6 workers. sendEmail throws locally and
  // instantly on an empty key (lib/email/send.ts:32-37, before new Resend()),
  // the route already tolerates that and still returns 201 with acceptUrl,
  // and Playwright MERGES this over process.env so DATABASE_URL survives.
  env: { RESEND_API_KEY: '' },
},
```

- [ ] **Step 2: Write the discriminating assertions**

There is a **second short-circuit upstream** of `sendEmail` — `members/route.ts:105-108` throws if `EMAIL_FROM_ADDRESS` is unset. If it is missing in CI, every obligation goes green while this task's entire mechanism is inert and untested. So the test must name *which* short-circuit fired:

```ts
// D-188 / O-2. Two assertions, because two different short-circuits produce
// an identical-looking 201 + copy-link, and only one of them is this task's
// mechanism. Asserting the rendered reason names RESEND_API_KEY (not
// EMAIL_FROM_ADDRESS) is what distinguishes "the intended fast path" from
// "a different fast path that looks the same" -- and it is the ONLY
// assertion that fails if a warm reused server calls Resend for real, since
// both MembersManager branches render the same anchor.
const invitePost = ownerPage.waitForResponse(
  (r) => r.url().includes('/members') && r.request().method() === 'POST',
);
await ownerPage.getByRole('button', { name: 'Invite' }).click();
const body = await (await invitePost).json();
expect(body.emailSent, 'the email leg must fail locally, not succeed remotely').toBe(false);
expect(body.emailError, 'must be the RESEND_API_KEY short-circuit, not EMAIL_FROM_ADDRESS')
  .toMatch(/RESEND_API_KEY/);
```

- [ ] **Step 3: Prove the assertion is non-vacuous**

```bash
# Temporarily restore the real key and watch the RESEND_API_KEY assertion fail.
npx playwright test e2e/two-orgs.spec.ts --grep "invitation"
```
Run once with `env: { RESEND_API_KEY: '' }` removed from the config. Expected: **FAIL** on the `emailSent`/`emailError` assertion (a real key means either a successful send or a Resend-specific error, neither of which names `RESEND_API_KEY`). Restore the config, re-run, expect PASS. **Record both outputs in the task report** — this is the proof that the pre-fix defect (green while calling Resend live) is actually closed.

- [ ] **Step 4: Write O-7 — the 201-with-`acceptUrl` integration test**

This path has **zero** coverage today and Task 3 makes the whole e2e depend on it.

```ts
it('returns 201 with a usable acceptUrl when the email leg fails', async () => {
  // PROPERTY: a failed email must never cost the inviter the copy-link.
  // WHAT THIS CAUSES: the route is called with no RESEND_API_KEY, so the
  // email leg throws; if that throw ever escapes the inner catch, the shared
  // handler returns 500 and this assertion fails. A regression to 500 would
  // otherwise surface only as a confusing e2e failure three files away.
  const res = await invitePost({ email: 'someone@example.test', role: 'assessor' });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.acceptUrl).toMatch(/\/invitations\/[A-Za-z0-9_-]+$/);
  expect(body.emailSent).toBe(false);
  expect(body.emailError).toMatch(/RESEND_API_KEY/);
});
```

Follow the existing integration-test setup idiom in `__tests__/integration/` for org/context construction — do not invent a new one.

- [ ] **Step 5: O-6 — cite, do not build**

`__tests__/unit/email-send.test.ts:68-75` **already** asserts both the throw and `expect(sendMock).not.toHaveBeenCalled()`, inside a test named *"throws without ever calling Resend when RESEND_API_KEY is not set — fails loud, not silent"*. **Add nothing.** Cite it in the task report as discharged. (An earlier draft of the spec said "extend it", which would have produced a duplicate assertion presented as work.)

- [ ] **Step 6: Full gates, then commit**

```bash
npm run lint && npm run typecheck && npx vitest run && npx playwright test
```

---

## Task 4: D-195 — the registration cap. **HUMAN-PARTNER DECISION REQUIRED BEFORE ANY CODE.**

**Files:**
- Modify: `lib/rate-limit.ts` (pending the ruling)
- Create: `__tests__/integration/rate-limit-headroom.test.ts` (O-10)
- Modify: `docs/DEFERRED_REGISTER.md` (D-195)

**STOP. Do not change a security control before this is ruled on.**

`lib/rate-limit.ts:21` is:

```ts
'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 5, keyBy: 'ip' },
```

**This is not a test-accommodation problem.** The primary adopter is African university teams. Campus networks and computer labs sit behind dense NAT, so the control is effectively **5 registrations per 15 minutes per institution**, not per person. The sixth colleague registering for a workshop is locked out for fifteen minutes, and the platform's own onboarding is the thing it blocks. This project has already recognised the shared-lab-machine reality once — a `what-if-oracle` Ψ finding that set session `maxAge` — and never carried it across to rate limiting. The e2e hitting the cap is therefore the **first observation of a production defect**, surfaced by the only consumer that happens to drive five registrations from one address.

- [ ] **Step 1: Fresh threat derivation — `engineering-skills:senior-security`**

Derive obligations **for this control, now**. Do **not** reuse the derivation written for the email transport seam earlier in this phase — that is the §2 "reusing a previously-derived conclusion" trigger, and §7.1 records that re-deriving per task is what found a runtime fail-open an earlier table did not contain. The derivation must cover at minimum: what mass-registration abuse actually costs here (each registration bootstraps User + Organization + Membership + consents), whether any control other than this one bounds it, and what an attacker behind the same NAT as legitimate users can do under each candidate value.

- [ ] **Step 2: Present the options to the human partner and WAIT**

Present at least: (a) raise the per-IP cap to a NAT-tolerant value; (b) two dimensions — a looser per-IP burst plus a global/window cap; (c) leave it and accept the onboarding failure, recorded as an accepted risk. Each with the abuse cost it admits. **Do not pick one and proceed.**

- [ ] **Step 3: Implement the ruling, then write O-10 — generated, not hard-coded**

```ts
// O-10. PROPERTY: the e2e suite must not sit at or above the registration
// cap, because the test that exceeds it is never the test that fails --
// whichever registration happens to be over the line gets the 429, so a spec
// added in a later phase reddens an unrelated, previously-green test.
// GENERATED, not written: the expected count comes from the exported
// RATE_LIMITS, so raising or lowering the cap moves this test with it. A
// hard-coded 5 would be a second literal to keep in sync -- the exact defect
// class AGENTS.md §3 says to generate away.
import { RATE_LIMITS } from '@/lib/rate-limit';

const cap = RATE_LIMITS['POST:/api/auth/register'].max;
const suiteRegistrations = countRegistrationsInSuite(); // enumerated from e2e/ on disk
expect(suiteRegistrations).toBeLessThan(cap);
```

`countRegistrationsInSuite()` must enumerate from disk (grep `e2e/**` for the registration submit affordance), not return a literal.

- [ ] **Step 4: Non-vacuity** — temporarily lower `max` below the suite's count, watch this test go red, restore, watch it pass. Record both outputs.

- [ ] **Step 5: Commit** with the D-195 row updated in the same commit.

---

## Task 5: The `test-e2e` CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1's two-invocation pattern and `webServer.command`; Task 3's no-secret property.

**Enumerate from the working job, do not inherit a comment.** An earlier draft asserted the job shape was "already specified by the workflow's own trailing comment". That comment is four commands long, and treating it as complete produced a job that could not boot — five reads with no writer. **Model this job on the existing `verify` job at `ci.yml:35-197`**, which is the proven reference for what an app process needs in CI.

- [ ] **Step 1: Pair every read with a writer**

Before writing YAML, produce this table in the task report and fill the right-hand column from the job you are about to write. **Any row without a writer is a defect, not an oversight:**

| Value | Read at | Behaviour when unset |
|---|---|---|
| `DATABASE_URL` | `lib/data/identity.ts:218`, `lib/data/preauth.ts:50` | throws |
| `APP_DATABASE_URL` | `lib/data/tenant.ts:125` | throws |
| `NEXTAUTH_SECRET` | `lib/auth/secret.ts:44-49` | throws |
| `EMAIL_FROM_ADDRESS` | `members/route.ts:105-108` | throws — and silently satisfies Task 3's obligations while its mechanism is inert (W-1) |
| `makrai_app` role + password | `scripts/provision-app-db-role.sh` | `APP_DATABASE_URL` cannot authenticate |
| schema + the `fv_3_0_0` row | `prisma migrate deploy`; row inserted by `prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql` | every `assessments.frameworkVersionId` FK fails |

- [ ] **Step 2: Write the job**

Required elements, each with a reason:

```yaml
  test-e2e:
    name: e2e
    runs-on: ubuntu-latest
    timeout-minutes: 30   # heavier than `verify`: next build + browser install + 20 real logins, run twice (see Step 3)
    env:
      POSTGRES_USER: makrai
      POSTGRES_PASSWORD: makrai_dev_password
      POSTGRES_DB: makrai_test
      DATABASE_URL: postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test
      APP_DATABASE_URL: <as provisioned, matching scripts/provision-app-db-role.sh>
      NEXTAUTH_SECRET: <a CI-only value; see lib/auth/secret.ts for the length/shape it requires>
      EMAIL_FROM_ADDRESS: ci@example.test   # W-1: without this the invite POST short-circuits
                                            # UPSTREAM of sendEmail and Task 3's mechanism is never exercised
    services:
      postgres: <same block as the verify job>
    steps:
      - checkout / setup-node with node-version-file: '.nvmrc' / npm ci
      - npx prisma generate
      - npx prisma migrate deploy
      - scripts/provision-app-db-role.sh makrai_test
      - npm run build
      - npx playwright install --with-deps
      - npx playwright test --project=setup      # creates the fixture manifest (Task 1)
      - npx playwright test --fail-on-flaky-tests
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

- [ ] **Step 3: `--fail-on-flaky-tests` is required, and here is why**

Verified present in the installed version: `node_modules/playwright/lib/program.js:177` and `runner/index.js:529`. Without it, `retries: 2` means a run reports **green** unless a test fails three consecutive attempts — measured at **96.3%** green with a flake fully alive. "Green" must mean *zero retries consumed*, or the gate reports success on a suite that is quietly failing. **State in the report** that the setup project runs twice (once standalone, once via `dependencies: ['setup']`), costing ~20 extra logins — a real cost, recorded rather than hidden.

- [ ] **Step 4: Run it for real and iterate to green**

Push the branch; read the actual run. Do not reason about whether the YAML is right — the D-146 closure found two genuine defects (a `docker exec` target that does not exist in CI, and a missing Prisma generate hook) *by running the pipeline rather than reading it*, and the first CI push of that work failed on a real workflow-file validation error.

- [ ] **Step 5: Commit**

---

## Task 6: Promote to required, with a demotion path

**Files:**
- Modify: `docs/DEFERRED_REGISTER.md` (D-193 amendment, or a new row citing it)
- GitHub branch-protection settings (API call, not a repo file)

**Carry D-193's two hard-won facts.** D-193 was closed the same day and is the row that *created* this mechanism.

- [ ] **Step 1: Read the context name from a live check-run — never transcribe it**

```bash
gh api "repos/{owner}/{repo}/commits/$(git rev-parse HEAD)/check-runs" --jq '.check_runs[] | .name'
```

Required-status-check matching is by check-**run** name, and a check run is produced per **job**. The workflow's top-level `name:` is `CI`; the existing job's name is `lint, typecheck, test, build`. Requiring `CI` would produce protection that looks configured and **blocks every merge forever** on a check that is never created.

- [ ] **Step 2: Add the new context to the existing list, do not replace it**

`enforce_admins: true` and `required_pull_request_reviews: null` mean a wrong name is a **merge deadlock with no admin bypass**. The escape hatch, recorded in D-193: `gh api -X DELETE repos/.../branches/main/protection`, then re-PUT.

- [ ] **Step 3: Verify both directions, as D-193 did**

Blocked: attempt a direct push to `main`, observe `GH006`, discard the probe. Allowed: this task's own PR merging green.

- [ ] **Step 4: Record the demotion path**

The row must state what evidence removes the check from the required list and who decides. Promotion with no way back on a public repo with no bypass is how a broken gate becomes permanent.

- [ ] **Step 5: Commit**

---

## Task 7: D-185 investigation — decoupled, blocks nothing

**Files:**
- Create: `e2e/fixtures/instrumentation.ts`
- Modify: `e2e/assessment-flow.spec.ts` (instrumentation wiring only; the test stays `fixme`)

**This task has no deadline and gates nothing.** It exists to produce a *finding*.

**Harness-only.** No file under `app/`, `lib/`, or `components/` may change — instrumenting a 900-line client component risks an observer effect on the very race being measured, and would put dev-only code on a production path. Use `page.addInitScript`.

- [ ] **Step 1: Run the cheapest experiment first — the timeout asymmetry**

`assessment-flow.spec.ts:218`'s `await expect(input).toBeChecked();` carries **no timeout**, so it uses the 5s default. Three siblings in the same file are explicitly hardened to `{ timeout: 15000 }` — `:103`, `:132`, `:135`. Someone already found that 15s was needed here under load, three times, and this assertion did not get it.

Add `{ timeout: 15000 }` to `:218`, un-`fixme` the test locally, and run the full suite **ten times**. Record the tally. This is not a claim that it fixes D-185 — it is the cheapest discriminating experiment available, and if the flake vanishes the cause was latency, not a dropped state update.

- [ ] **Step 2: If it survives, instrument — widened past a single sample**

A three-way table sampled once at assertion time **cannot** separate *slow* from *dropped*: both present as "change fired, checked false". Capture instead:

```ts
// e2e/fixtures/instrumentation.ts -- harness only, installed via addInitScript.
// Records WHEN, not just WHETHER, because a `checked` that flips at t=6s is a
// timeout artifact and one that never flips is a dropped state update. A
// MutationObserver is what makes the post-deadline value observable at all.
export const CAPTURE = `
window.__d185 = { clicks: [], changes: [], flips: [], errors: [] };
document.addEventListener('click',  e => window.__d185.clicks.push({ t: performance.now(), target: e.target?.outerHTML?.slice(0,120) }), true);
document.addEventListener('change', e => window.__d185.changes.push({ t: performance.now(), id: e.target?.id, checked: e.target?.checked }), true);
window.addEventListener('error',    e => window.__d185.errors.push({ t: performance.now(), msg: String(e.message) }));
new MutationObserver(ms => { for (const m of ms) if (m.attributeName === 'checked')
  window.__d185.flips.push({ t: performance.now(), checked: m.target.checked }); })
  .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['checked'] });
`;
```

Attach the captured object to the Playwright report with `testInfo.attach` so the finding survives the run — at a ~1-in-3 rate, needing to re-reproduce costs three more runs.

- [ ] **Step 3: Write the finding into D-185**

Name which mechanism occurred, quote the artifact, and state whether the quarantine can be lifted. Four mechanisms produce "change fired, checked false" — a 5s timeout on a correct update, the updater returning `prev`, a throw inside the updater (hence `errors`), and a genuinely dropped update. The finding must say which.

- [ ] **Step 4: Register the adjacent defect regardless of the outcome**

`AssessmentPageClient.tsx:431-439` calls `autoSave(next)` **inside** the `setEngineState` updater. React requires updaters to be pure and may invoke them more than once; with StrictMode on and React 19.2.4, dev double-invokes them. This is a real contract violation **independent** of D-185 and gets its own row whether or not it is the cause. Do **not** fix it inside this task unless the finding implicates it — that would be changing a variable mid-investigation.

---

## Self-Review

**1. Spec coverage.** O-1→Task 2 · O-2→Task 3 · O-3→Task 1 · O-4→Task 5 · O-5→Task 5 Step 3 · O-6→Task 3 Step 5 (cite only) · O-7→Task 3 Step 4 · O-8→Task 6 Step 1 · O-9→Task 6 Step 4 · O-10→Task 4 Step 3. DoD §11 items 1-6 map to Tasks 2, 3, 1, 5, 6, 4 respectively. **No spec requirement is unassigned.**

**2. Placeholder scan.** Two deliberate gaps, both flagged rather than hidden: Task 4 Step 3's implementation depends on a ruling that has not been made, and Task 5's `APP_DATABASE_URL`/`NEXTAUTH_SECRET` values are marked `<...>` because they must be read from `scripts/provision-app-db-role.sh` and `lib/auth/secret.ts` rather than invented. Both name the file to read. No "TBD", no "add error handling".

**3. Type consistency.** `RATE_LIMITS['POST:/api/auth/register'].max` matches the exported shape at `lib/rate-limit.ts:20`. `webServer.env` and `webServer.command` are the keys Playwright's `TestConfigWebServer` actually declares (verified in `node_modules/playwright/types/test.d.ts`). `test.fixme` is Playwright's own API. `body.emailSent`/`body.emailError` match the field names `members/route.ts` returns.

**Task ordering is a hard dependency chain, not a preference:** 1 before 5 (the job cannot run an uncollectable suite) · 2 before 5 (the job must be green) · 3 before 5 (or CI needs a secret) · 4 before 6 (the phase that arms the gate clears the chamber) · 5 before 6 (nothing to require until the check exists). 7 is parallel to all of them.
