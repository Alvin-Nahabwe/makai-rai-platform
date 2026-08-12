# Phase 1d-i — Put the end-to-end suite on the gate

**Status:** design v2, awaiting human-partner approval
**Branch:** `phase1d-i-e2e-trustworthy`
**Supersedes:** v1 of this file, which was **BLOCKED** (5 Critical) — see §2.
**Rows closed:** D-188. **Rows opened:** rate-limit headroom, trace-token exposure.
**Rows deliberately NOT closed:** D-185 (quarantined, see §3), D-177/178/180/182/186/187/194.

---

## 1. Goal

> Put the end-to-end suite on the required check — minus one named, quarantined spec —
> so that live browser verification, which AGENTS.md C5 defines as *done*, is enforced by
> machine before Phase 1d-ii lands the changes only a browser test can see.

**Single responsibility:** get the gate up. **Explicitly not its job:** fixing D-185,
changing what the tests assert, or any product feature. One product change is in scope
(§7) and only because this phase is what makes the check blocking.

**What "minus one named spec" buys.** v1 tried to promote a suite containing a known
flake, which forced a statistical promotion threshold. That threshold was the single
largest source of defects in v1 (§2.2). Quarantine removes the flake from the required
set, so the threshold is not solved — it is **deleted**. This is the mechanism
`ci.yml:226` already names — *"D-185 and D-188 fixed **or explicitly quarantined**
(Playwright's own retry/annotation mechanism, not silence)"* — and which v1 quoted the
second half of while dropping the first.

---

## 2. Why v2 exists: what two independent reviews found in v1

v1 passed my own review. It was then attacked by `engineering-skills:adversarial-reviewer`
(briefed at the decomposition) and `what-if-oracle` (Deep Oracle, *"what if this ships
exactly as specified?"*). Verdict: **BLOCK**, 5 Critical / 5 Warning / 3 Note, plus four
Oracle branches. Self-review is now 0-for-8 on this class; independent review is 8-for-8.

Recorded here rather than quietly fixed, because the *pattern* is the reusable part.

### 2.1 The root cause both reviews independently named

v1 varied the **predicate** and never the **search root**. Its §7 "second lens" genuinely
asked a different question, but asked it of the same three subtrees: `playwright.config.ts`,
the email path, the CI job. Four roots were never searched:

| Unsearched root | What lived there |
|---|---|
| build-time artifacts under `e2e/fixtures/` | C-3: the suite cannot be *collected* on a cold checkout |
| the app's runtime environment | C-4: the CI job cannot boot — five reads with no writer |
| the browser/server boundary **inside Playwright** | C-1: the phase's one anti-vacuity control was vacuous |
| the register's recently **CLOSED** rows | W-4: D-193, closed 90 minutes earlier, created the mechanism v1 proposed to change and was cited nowhere |

AGENTS.md §3 already says *"vary the search root, not only the predicate"*. v1 was written
by someone who had read that sentence that morning. **Knowing the rule did not fire it** —
which is the argument for binding it to a checkpoint rather than to understanding.

### 2.2 The five Criticals

- **C-1 — the anti-D-191 control was itself D-191.** O-5 asserted "no Resend call" via a
  Playwright route interceptor. `page.route` intercepts **browser** traffic; Resend is
  called by the **Next server process** (`route.ts:110` → `send.ts:32-38`). The
  interceptor cannot fire, so O-5 passed identically either way. Worse: both
  `MembersManager` branches render the same anchor (`~215-221`, `~222-227`) and the test's
  selector is branch-agnostic (`two-orgs.spec.ts:92-93`), so a warm reused server **passes
  green while calling Resend live** — the exact trap v1 §4 claimed to close.
- **C-2 — the threshold was computed for a config the suite does not use.**
  `playwright.config.ts:6` is `retries: 2` in CI, so a run reports green unless a test
  fails three consecutive attempts. Measured: a run reports green **96.3%** of the time
  with the flake fully alive → **56.8%** chance of clearing fifteen greens **unfixed**, in
  ~21 runs. Dissolved by quarantine; the residual is fixed by O-9.
- **C-3 — a cold checkout cannot collect the suite.** Four specs `readFileSync(MANIFEST_PATH)`
  at **module scope** (`assessment-flow:33`, `evidence-lifecycle:26`, `two-orgs:33`,
  `role-matrix:50`); `.gitignore:53` ignores `/e2e/fixtures/.auth/`; `dependencies: ['setup']`
  orders **execution**, not **loading**. Invisible locally forever, because the file has
  existed on this machine since 2026-08-04.
- **C-4 — the job cannot boot.** v1 named exactly one environment variable: the one to
  *remove*. `APP_DATABASE_URL`, `NEXTAUTH_SECRET`, `DATABASE_URL`, the `makrai_app` role,
  and `prisma migrate deploy` (sole writer of the `fv_3_0_0` framework row) were all reads
  with no writer. This is the D-143 shape for the third time, committed in the same session
  in which I named that shape as the organising theme of Phase 1d-ii.
- **C-5 — no unit fixed D-185, yet §1 listed it as closed.** Resolved by the reframe in §1.

### 2.3 The Oracle branches that survived independent verification

- **α — the job shape throws.** v1 copied `next start &` then `playwright test` from the
  workflow comment. In CI `reuseExistingServer` is `false`, and Playwright **errors on an
  occupied port** — verified at `node_modules/playwright/lib/runner/index.js:821-827`. The
  tempting repair (`reuseExistingServer: true`) makes Unit B's `webServer.env` dead code.
  Only letting Playwright own the server keeps both alive. §6 does that.
- **Φ — v1's discriminating table does not discriminate.**
  `assessment-flow.spec.ts:218`'s `toBeChecked()` carries **no timeout**, so it uses the 5s
  default, while three siblings in the same file are hardened to `{ timeout: 15000 }`
  (`:103`, `:132`, `:135`). A slow-but-correct update and a dropped update are therefore
  **indistinguishable** at the sampling point v1 chose. §3's instrumentation is widened
  accordingly.
- **Ψ — a landmine for the next phase.** `POST:/api/auth/register` is capped at 5 per
  15 min per IP (`lib/rate-limit.ts:21`) and the suite already drives ~5 registrations.
  Zero headroom, invisible per-file, and the in-memory counter survives across local runs
  via `reuseExistingServer`. Human partner ruled this fixed **in 1d-i** — the phase that
  arms the gate clears the chamber. §7.
- **∞ — the gate's own lifecycle is unspecified.** The repo is **public**;
  `enforce_admins: true` with no bypass; and `on: push` + `pull_request` already produce
  **two runs per commit** (`ea5f0e5a` → runs `31373065818` and `31373107567`). "Fifteen
  consecutive runs" was ambiguous even before C-2 killed it, and v1 specified no
  **demotion** path at all.

### 2.4 One claim in v1 that verification *upheld*

Unit B's mechanism is sound, and this was executed rather than reasoned: an empty-string
`RESEND_API_KEY` **survives** Next's `.env` load (`@next/env` does not overwrite an
already-defined key, even an empty one) while other keys still load; and Playwright merges
rather than replaces — `runner/index.js:834-838`:

```js
env: { ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...this._options.env },
```

Load-bearing: had `env` replaced, blanking one key would have stripped `DATABASE_URL` too.

---

## 3. D-185 is quarantined, not fixed — and its investigation is decoupled

**Quarantine, per `ci.yml:226`'s named mechanism:** the failing test is marked
`test.fixme` with a reason string naming D-185. Playwright reports it as expected-to-fail
and does not run it, so it cannot redden the gate, and it is **visible in every run's
output** rather than silently absent — which `test.skip` behind a conditional would not be.

**What this costs, stated rather than glossed:** the answer-recording path — the product's
core interaction — has **no CI coverage** until D-185 closes. That is the price of the
gate existing at all, and it is recorded in the D-185 row as the quarantine's own
consequence, with the pick-up trigger being the investigation below.

**The investigation, widened after Φ.** v1's three-row table classified on a single
sample at assertion time, which cannot separate *slow* from *dropped*. It is replaced by:

- capture-phase `click` and `change` listeners **with timestamps** (harness-only, via
  `addInitScript` — still no product-code change);
- a `MutationObserver` on the input's `checked` property, so a value that flips **after**
  the assertion deadline is recorded rather than lost;
- `window.onerror` / `pageerror` capture, since a throw inside the state updater is one of
  the four mechanisms Φ identified and would otherwise present identically.

The first question is now *"did `checked` ever become true, and when?"* — which separates
a 5s-timeout artifact from a genuinely dropped update. Nothing in this phase depends on
the answer.

---

## 4. Unit A — quarantine and the gate

Mark the flaky test `test.fixme` with a reason naming D-185. No other spec changes.

## 5. Unit B — D-188: remove the network call, add no mechanism

`playwright.config.ts` gains `webServer.env` with `RESEND_API_KEY` blanked. `sendEmail`
then throws locally and instantly (`send.ts:32-37`, before `new Resend()` is constructed),
the route catches it as it already does, and responds 201 with `acceptUrl` and
`emailSent: false`.

**No transport seam.** v1's proposed capture transport was deleted by its own security
pass: the guard (`opt-in env var` AND `NODE_ENV !== production`) was two locks with one
key, and the seam was a credential-harvesting gadget for the only message this app sends —
an invitation embedding a single-use bearer token. The safest version of a dangerous
mechanism is the one not built.

**Assertions must be browser-observable (C-1) and must discriminate (W-1).**
`EMAIL_FROM_ADDRESS` is a *second* short-circuit, **upstream** of `sendEmail`
(`route.ts:105-108`), unset in CI unless added. If it is missing, every obligation goes
green while Unit B's mechanism is inert. So the test asserts, via `page.waitForResponse`
on the members POST and on the rendered error text:

1. the response body has `emailSent: false`; **and**
2. the rendered `emailError` names **`RESEND_API_KEY`** — not `EMAIL_FROM_ADDRESS`.

Assertion 2 is what makes the difference: it distinguishes *the intended fast path* from
*a different fast path that looks identical*, and it is the only assertion that fails when
a warm reused server calls Resend for real.

## 6. Unit C — make the suite collectable, and let Playwright own the server

**C-3:** the fixture manifest must exist at **collection** time on a cold checkout. Two
candidate repairs; the plan picks one and states why:
(a) move each spec's `readFileSync` out of module scope into a lazy accessor, so collection
no longer touches the file; or (b) have CI run the `setup` project as a separate prior
invocation. (a) is preferred — it fixes the property everywhere, including a developer's
first clone, rather than only in CI.

**α:** `webServer.command` becomes environment-dependent — `npm run dev` locally,
`next start` (after a build step) in CI — and the job does **not** launch a server itself.
This keeps `reuseExistingServer: false` meaningful in CI and keeps Unit B's `webServer.env`
live. **Ownership of `playwright.config.ts` is assigned per key** so Units B, C and the
D-185 investigation cannot silently overwrite each other's changes to one file.

## 7. Unit D — rate-limit headroom (Ψ), fixed here by ruling

`POST:/api/auth/register` at 5 per 15 min per IP, with the suite already at ~5, means the
first registering spec added in Phase 1d-ii reddens an *unrelated* test under a *required*
check. This is a **security control**, so the change gets the §7.1 preventive pass and a
threat derivation of its own before it is written — it is not a number to quietly raise.
The register row is opened in the same commit regardless of the fix, per §6.

## 8. Unit E — the CI job, enumerated rather than inherited

v1 asserted the job shape was "already specified by the workflow's own trailing comment".
That comment is four commands long, and treating it as a complete enumeration is the C-4
defect. The job is specified here from the **existing `verify` job**, read from
`ci.yml:35-197`, as the working reference for what an app process needs in CI:

job-level `env` (`DATABASE_URL`), `prisma generate`, `prisma migrate deploy` (sole writer
of the `fv_3_0_0` row every `assessments.frameworkVersionId` FK depends on),
`scripts/provision-app-db-role.sh` with `APP_DATABASE_URL`, `NEXTAUTH_SECRET`,
`EMAIL_FROM_ADDRESS` (W-1), `next build`, `playwright install --with-deps`, an explicit
`timeout-minutes`, and artifact upload on failure.

**W-5 / ∞ — the job's own lifecycle:** trigger scoping (the existing workflow is `on: push`
for *every* branch plus `pull_request`, producing two runs per commit), the `concurrency:
cancel-in-progress` interaction, and a stated cost estimate. A **demotion path** is
specified alongside promotion: what evidence removes the check from the required list, and
who decides — v1 specified promotion with no way back.

## 9. Proof obligations

| # | Property | Test, and what it causes |
|---|---|---|
| **O-1** | The quarantined test cannot redden the gate, and is visible in every run. | `test.fixme` with a D-185 reason; the run output lists it. Causes: `test.skip` behind a conditional would satisfy "not red" while hiding it — this does not. |
| **O-2** | The invitation e2e makes no Resend call, **and** the reason is `RESEND_API_KEY`, not `EMAIL_FROM_ADDRESS`. | Assert response `emailSent: false` **and** rendered error text names `RESEND_API_KEY`. Causes: a warm reused server calling Resend live renders the *success* branch with no error text — the assertion fails. This is the obligation C-1 showed v1 could not express. |
| **O-3** | The suite can be collected on a checkout that has never run it. | `git clone` to a clean directory, `npx playwright test --list`, expect exit 0 and 49 tests. Causes: a module-scope read of a gitignored file throws ENOENT during collection and the command fails. |
| **O-4** | The CI job boots. | The job runs green with no manual intervention. Causes: any missing env var or migration makes the app throw at startup; O-4 is discharged by the run, not by inspection. |
| **O-5** | Green means **zero retries consumed**. | `--fail-on-flaky-tests` (verified present: `playwright/lib/program.js:177`, `runner/index.js:529`). Causes: a test that passes only on retry exits non-zero, so "green" cannot silently mean "flaky but recovered" — the C-2 defect, fixed mechanically rather than by the prose carve-out v1 used. |
| **O-6** | `sendEmail` still refuses loudly on a missing key. | **Already discharged** — `__tests__/unit/email-send.test.ts:68-75` asserts both the throw and `expect(sendMock).not.toHaveBeenCalled()`. Cite it; add nothing. (v1 specified extending a test that already contained the assertion verbatim — N-1.) |
| **O-7** | The invite route returns 201 with a usable `acceptUrl` when the email leg fails. | New integration test. Causes: zero coverage today, and Unit B makes the whole e2e depend on it. |
| **O-8** | Promotion carries D-193's two facts. | The required context string is read from a live `check-runs` response, not transcribed; the row cites `enforce_admins: true` and the escape hatch. Causes: a wrong context name is a **merge deadlock with no admin bypass** — W-4. |
| **O-9** | A demotion path exists. | Stated in the register row: the evidence that removes the check and who decides. Causes: v1 had promotion with no way back on a public repo with no bypass. |
| **O-10** | Registration headroom is not zero when the gate goes blocking. | A test asserting the suite's registration count against the configured cap, generated from `lib/rate-limit.ts` rather than hard-coded. Causes: adding a registering spec without raising headroom fails *this* test, not an unrelated one 200 lines away in another file. |

## 10. Decomposition check — the roots now searched

Generated from four roots, not one predicate: **what blocks the gate**; **what the gate
does once it exists** (demotion, cost, triggers, the four states a check can be in);
**build-time artifacts** (`e2e/fixtures/`); and **recently closed register rows** (D-193,
D-146). The fourth is new and is the one v1 had no lens for — a closed row reads as
finished, so it leaves the search space exactly when its facts become load-bearing again.

**Claim each verification proves.** O-2 proves *no live call and the intended reason*, not
*email works*. O-3 proves *collectable*, not *passing*. O-4 proves *this job booted*, not
*the app is correct*. O-5 proves *no retry was consumed*, not *no flake exists*.

## 11. Definition of done

1. The quarantined test is marked, with a reason, and D-185's row records both the
   quarantine and its coverage cost.
2. The invitation e2e passes with O-2's discriminating assertions.
3. A cold clone can collect the suite (O-3).
4. A `test-e2e` job runs green in CI against a production build, with `--fail-on-flaky-tests`.
5. The check is promoted to required, carrying D-193's facts, with a demotion path recorded.
6. Registration headroom is fixed and pinned.

Unlike v1, **outcome 5 is reachable**: with the flake quarantined there is no statistical
threshold to clear.

## 12. What this does not establish

- Not D-185's cause. §3 is built to find it and blocks nothing.
- Not coverage of the answer-recording path in CI. Quarantine removes it until D-185 closes.
- Not that the `emailSent: true` branch works. It had no coverage before and has none now.
- Not that traces are safe to publish. Playwright traces carry DOM snapshots and
  screenshots, and after this phase the page displays a raw `acceptUrl` as visible link
  text; `trace: 'on-first-retry'` plus `retries: 2` means traces are produced routinely and
  DoD-4 uploads them **off the machine**. Harmless while CI orgs are ephemeral; recorded as
  its own row scoped to the *rendered* token, not only the network response — W-3, where v1
  reached the right conclusion by the wrong derivation, and the derivation is what a future
  reader inherits.
