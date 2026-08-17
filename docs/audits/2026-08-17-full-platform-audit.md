# Full end-to-end platform audit — 2026-08-17

**Status:** REPORT ONLY. Nothing found here has been fixed; no register rows were opened or
closed; no rules were amended. Every action this report implies is a decision for the human
partner. The full per-finding record (all 195 findings, with evidence and verification
verdicts) is in `2026-08-17-full-platform-audit-appendix.md` beside this file.

**Commissioned as:** "a full, deep, thorough and end to end Audit/review … EVERYTHING that is
auditable … The goal is not just to confirm if something works, but to check whether it is
doing what it is supposed to do … A functional design/feature is not necessarily a good one."
Context change taken as input: **a VPS and domain are procured — deployment is now
live-relevant, not parked.**

---

## 1. Method, and this report's own confidence boundary

- **17 parallel audit dimensions**, each an independent auditor with a scoped brief and an
  evidence rule (every claim carries a file:line citation or a command with its output;
  anything unverifiable is labelled `unconfirmed` with the reason): tenancy/RLS, authn/session,
  authz/RBAC, engine & scoring, the assessment client, the full API surface, evidence pipeline,
  reports/PDF/export, framework versioning, test-suite quality, CI/devx, deployment/ops,
  process/register health, product-vision fit, dependency/platform risk, a live gates run, and
  docs accuracy. Audited tree: `main` @ `5cc4e2a` plus the PR #6 docs commit (`e5bceee`).
- **Adversarial verification:** all 46 Critical/High findings were re-examined by independent
  verifiers briefed to *refute* them — re-reading the cited code, re-running cited read-only
  commands (including `docker compose config`, `prisma migrate diff`, `npm audit`, and an
  execution of the production scoring engine), and hunting for rescuing context the auditor
  missed. Result: **39 CONFIRMED, 7 OVERSTATED (6 downgraded High→Medium, 1 narrowed but kept
  High), 0 REFUTED.** The downgrades are listed in §6; the report below uses post-verification
  severities throughout.
- **Coverage critique:** a final agent hunted for what the whole audit missed, from roots the
  dimension list did not use (tree walk, lifecycle walk, stakeholder walk). Its findings are
  §8 — they are part of the report, not an afterthought.
- **Live gates at audit time:** `tsc --noEmit` clean; vitest **1579/1579** in ~52s; `next build`
  clean; Playwright collects 49 tests. `npm run lint` was **red as found** — untracked residue
  `app/__effective_config_probe.ts` left by an interrupted test run (QG-1/T-09); it self-healed
  when the suite re-ran. Last full CI on `main` (both required jobs, including live e2e):
  green, 2026-08-13.
- **What this audit did NOT do — its confidence boundary (details §8):** nothing was executed
  live end-to-end (no browser walk, no Docker image build/boot, no e2e run — the deploy-DOA and
  race findings rest on static analysis plus targeted command reproduction); the framework
  *content* (78 questions / 21 areas / 28 controls) was audited by no dimension; the register
  was sampled, not read end-to-end; the SPA→platform cutover path was walked by nobody.

## 2. Verdict

**The inner ring of this platform is genuinely excellent, and the outer shell is not built.**

The parts that received the project's process — RLS tenancy, RBAC, framework pinning, evidence
row-level engineering, the CI pipeline, the register discipline — repeatedly survived hostile
verification, often with the verifier reporting "I tried to kill this and failed." The RLS mesh
was verified live against the test database; the 726-cell permission matrix drives real
handlers; closures cite commits and red-before-green proofs. This is rare and worth saying
plainly: **the security spine is real.**

But the product a real team would meet is not that spine. It is:

1. **Undeployable as documented** — the deployment path fails at four independently confirmed
   points before one user can log in (§3, C-1..C-3), and it was never once executed.
2. **Lossy where it matters most** — the assessment data path silently discards user answers
   under a dozen distinct conditions, with no indicator, no retry, and no conflict control
   (§4, theme B).
3. **Headlined by a number the project's own vision calls indefensible** — and the scoring
   engine computing it has a confirmed correctness defect that caps one principle at ~31/100
   with perfect answers (§3, C-5; §4, theme C).
4. **Promising things it cannot do** — a privacy policy offering withdrawal/deletion controls
   that do not exist; a remediation "loop" with no writer; a password-recovery page giving
   false instructions; credibility tiers absent from any UI (§4, theme D).

None of the five vision shifts is fully delivered. What exists today is, functionally, the
free SPA plus accounts, tenancy, evidence upload, and version pinning. The distance between
the vision document and the product is now the largest defect in the project — larger than any
single code finding — because sequencing decisions keep being made against the vision's
categories ("Phase 2: artifact generation") while week-one adopter reality (deploy, recover a
password, not lose answers, trust the score) is unowned.

## 3. The five Criticals — all CONFIRMED under adversarial verification

**C-1. The documented production deployment cannot start. (DEP-01 + CFG-01)**
`docs/runbooks/deployment.md` §6.1 says to run
`docker compose -f docker/docker-compose.prod.yml up -d --build` from the repo root after
writing values into repo-root `.env`. Compose does not read that file for this invocation: the
verifier ran `docker compose config` and watched every variable default to a blank string —
Postgres receives an empty password, which the official image refuses, so the database never
becomes healthy and the app (which `depends_on: service_healthy`) never starts. There is no
`env_file:` directive and no `docker/.env`. **First step of the runbook, dead.**

**C-2. Even with C-1 fixed, the app container is missing its tenant-database credential.
(DEP-02 + DOC-13)** The prod compose passes exactly three env vars (`DATABASE_URL`,
`NEXTAUTH_SECRET`, `NEXTAUTH_URL`). `APP_DATABASE_URL` — the connection the entire RLS
architecture runs on — is not among them, and `lib/data/connection.ts` throws on its absence.
The container boots healthy and then **every tenant-data request 500s**. `RESEND_API_KEY`,
`EMAIL_FROM_ADDRESS`, and the admin-seed vars are likewise absent (invitations return 201 with
`emailSent:false` — silently mail-dead). Register row D-076 fixed the *runbook text* half of
this on 2026-08-12 and explicitly left the enforcement half open; compose was never touched.

**C-3. Even with C-1 and C-2 fixed, production login is a guaranteed outage. (DEP-03)**
Under `NODE_ENV=production`, NextAuth v5 requires `trustHost`, which is set from `AUTH_URL` /
`AUTH_TRUST_HOST` — not from the `NEXTAUTH_URL` the compose file passes. The verifier traced
this through the installed `@auth/core` source and found no escape hatch anywhere in app code.
CI itself hit this exact failure, reproduced it live (`csrf → 500 UntrustedHost`), and fixed it
**in CI only** (`ci.yml` sets `AUTH_TRUST_HOST=true`; production config does not). The repo
contains a documented live reproduction of its own production outage.

**C-4. (Same class, fourth member, High not Critical) There is no working path to run
migrations or seed in production. (DEP-05, DEP-06)** The runbook's `docker exec nextjs …`
targets a container name that does not exist (real name `docker-nextjs-1`); `prisma` and `tsx`
are devDependencies absent from the shipped standalone image; `prisma/seed.ts` imports
`lib/…` files the Dockerfile never copies; the Postgres service publishes no ports for
host-side execution; and nothing in the deploy sequence provisions the `makrai_app` role's
password — the RLS role cannot authenticate even if everything above is fixed.

**C-5. A scoring correctness defect caps the pre-processing Transparency principle at ~31/100
with perfect answers. (ENG-01)** The verifier *ran the production engine*: every pre-processing
answer at maximum yields Transparency & Explainability = 31 (gate answered Yes) or 23 (gate
No), while all seven other principles reach 100. Cause: the gate question declares `weight: 0`,
`AssessmentEngine.js:403` coerces falsy weights to `1.0`, and gates normalize to score 0 — so
every assessment carries a permanent dead weight in that principle. This is not a
methodological debate; it is an arithmetic bug in the number institutions would present.

**The pattern in C-1..C-4:** each is individually loud and quickly fixable once seen. Their
force is joint: the deployment path has **never been executed**, and each of its first four
steps fails independently. This is the one part of the system where the project's own doctrine
("live end-to-end verification is the definition of done") was never applied — the deployment
artifacts predate the current architecture and were never re-run against it.

## 4. The 35 confirmed Highs, by theme

Full text of every finding is in the appendix; this section gives each theme in plain terms.

**A. Deployment and operations (9 further Highs).** Beyond the Criticals: `proxy.ts` calls
`getToken()` without `secureCookie`, so behind TLS it cannot read the `__Secure-` session
cookie and **every userId-keyed rate limit silently degrades to shared per-IP buckets** — for
the NAT'd classroom population the limiter's own comments name as its target (DEP-04). The
security audit trail is stdout-only and erased by every redeploy (DEP-07). The backup script's
error branches are dead code under `set -e`, backups default to the same disk, and restore has
never been executed — a fresh-VPS restore also silently loses the cluster-level `makrai_app`
role, because `pg_dump` output contains its grants but not its `CREATE ROLE` (DEP-08, DOC-03).
Runbooks show no evidence of ever having been executed (DEP-10). Production email delivery to
real university addresses has no documented working path (DEP-09, downgraded Medium on impact
but the gap is real).

**B. The assessment data path loses user work silently (7 Highs).** The single worst product
behaviour, assembled from confirmed pieces: `autoSave` never checks `res.ok` and its catch is
empty — every server refusal (completed-in-another-tab 409, framework-drift 409, expired
session 401, 500) is invisible while the UI keeps accepting answers (AC-04, PT-03, FV-1);
completion handlers never cancel the pending debounce and navigate to the report regardless of
failure (AC-07); there is no optimistic locking or conflict detection anywhere — two tabs or
two teammates silently clobber each other via whole-blob replacement, and `Assessment.version`
is an attempt counter, not a lock (AC-05, TEN-02); the server-side completion/autosave race the
code's own comments claim was fixed is narrowed, not closed — READ COMMITTED, no `FOR UPDATE`,
no status predicate on the UPDATE (TEN-02, AC-06); and the evidence-upload half of the
immutability invariant has the exact TOCTOU race its delete half already fixed with
`FOR UPDATE` (EV-1). The e2e test that would catch the journey is quarantined (`test.fixme`),
and the ruled-approved jsdom infrastructure is still not installed (T-02, T-06, PH-3).
D-185 itself was **downgraded** by verification: in a production build the mount effect issues
exactly one GET, so the deterministic trigger is dev-only — it remains a real dev-mode data
destroyer and a latent production hazard, but "production-reachable today" was overstated
(AC-01 → Medium).

**C. Scoring and the engine (4 further Highs).** `engineState` is client-authored JSON
persisted with only a truthy-key check — server-side stage gating does not exist, and a
malformed blob 500s completion and bricks the assessment UI (ENG-02). Eighteen cross-stage
likert mappings across 11 of 21 areas are silently dropped from area scores while the findings
layer counts them — the two layers disagree about the same data (ENG-03). The single-percentage
headline the vision explicitly condemns is still the unmarked headline of dashboard, report,
and PDF (ENG-04) — and the "provisional score" marker that register row D-037 records as the
shipped mitigation **was never implemented; the row states it as fact** (ENG-05 — a register
row asserting something false, the project's own "laundered deferral" failure mode). The
engine-classification test suite asserts a test-local replica while the production classifier
(`useFindingsData.ts`) has zero coverage (T-01).

**D. Declared but never wired — the product promises things that do not exist (6 Highs).**
The privacy policy promises consent withdrawal, export, and deletion "from your account
settings"; no account-settings surface exists, nothing ever writes `researchConsent` after
registration, and the export/delete APIs have zero UI callers — consent is being collected
today against promises the product cannot honor (PT-01). The remediation loop — vision shift 5,
with routes, UI, badges, and evidence linkage all built — sits on a table **no production code
ever writes**, and the register row deferring the writer justifies it with a claim about the
engine that is factually false (PT-02). The forgot-password page instructs users to contact an
admin "who can reset your password from the admin panel" — no such capability exists anywhere
(AUTH-01). `mustChangePassword` enforcement has no production writer (AUTH-02, Medium). The
credibility-tier ladder — the vision's structural answer to box-ticking — is a two-value
derived enum no UI displays (EV-3, Medium). This class now has at least ten members and is
this codebase's most distinctive recurring defect shape.

**E. Framework lifecycle is undesigned beyond the pin (3 Highs).** The pin itself is excellent
— but publishing a new framework version is an undesigned, untooled, undocumented operation
(FV-3); any first content change **permanently strands every in-progress assessment
platform-wide** because pinned content is not retained anywhere and drift 409s block all
writes (FV-2); and those drift refusals reach the user as silence (FV-1, theme B). Register
row D-147 already records that even a formatter run on the JSON bricks assessment creation.
The standards crosswalk (ISO 42001 / AU strategy / UNESCO EIA) — a locked, non-negotiable
product decision — has no structural trace, and the AU strategy appears exactly once in all
content (FV-6, Medium).

**F. Dependency risk is unmanaged (3 Highs).** The entire auth system rides
`next-auth 5.0.0-beta.31`, whose `@auth/core` carries a critical-severity advisory chain fixed
in beta.32 — published four weeks before the audit and unapplied (DEP-1). Next.js 16.2.9
carries 9 high-severity advisories fixed in 16.3.1, including a proxy/middleware bypass
relevant to `proxy.ts` (DEP-2). Production `npm audit`: 12 vulnerabilities (2 critical, 5
high, 5 moderate), reproduced exactly by the verifier (DEP-11). No surveillance mechanism —
no CI audit step, no dependabot/renovate, no register row — exists to ever notice a CVE
(DEP-3, Medium). By the project's own §6 standard, this is an unrecorded accepted risk.

**G. Authorization lifecycle gaps (2 Highs).** The last-owner invariant counts membership
rows, not usable owners — platform-admin deactivation of a co-owner followed by the other
owner leaving orphans the org with zero functioning owners, defeating three separately-built
guards (AUTHZ-1). Drift 409/completion failures on the report path produce a feedback-free
redirect loop (R-07, Medium). The report page's every mitigation-control link targets a route
that does not exist — `/controls` instead of `/explore/controls` — so the remediation
on-ramp 404s (R-01).

**H. The outer record is untrue (4 Highs).** The README is verbatim create-next-app
boilerplate — the repo's front door describes a different project, and no working documented
cold start exists anywhere (DOC-01, CFG-02). The deployment and backup runbooks describe
procedures that demonstrably cannot produce or restore a working system (DOC-02, DOC-03).
Three "Phase 1" register rows display Open while a closed row asserts they were closed —
missed by four successive sweeps because every sweep filters by one target label (PH-2).
ADRs have drifted in specifics (dead module path, 404-vs-403 wording, a "required" memoisation
never built, ADR-0002 still "Proposed" while load-bearing) without amendment (DOC-04..07,
Medium).

## 5. What is genuinely sound

Fairness requires this list, and the verifiers repeatedly failed to break it:

- **The RLS mesh** — all 9 tenant tables + organizations ENABLE+FORCE, byte-identical
  fail-closed policies, verified live against the catalog; transaction-scoped parameterised
  GUC; app role NOSUPERUSER/NOBYPASSRLS with a runtime identity assertion; DDL event triggers
  auto-guarding new tables and refusing non-invoker views; default privileges revoked.
- **requireOrgContext / can()** — six facts proven per request from DB-fresh reads; fails
  closed against exotic inputs; 404-vs-403 policy consistent down to timing equalization;
  every route-method entry consults exactly the declared action (verified mechanically).
- **Membership concurrency** — `SELECT … FOR UPDATE` before last-owner counts; invitation
  single-use as a conditional status transition, proven by a two-user race test.
- **The evidence row layer** — bytes under RLS with composite FKs, DB-enforced write-once (no
  UPDATE grant), magic-byte default-deny, hardened download headers, hash-verified fail-closed.
- **Framework pinning core** — hash-of-bytes registry, DB write-once pin, four fail-closed
  drift guards pinned by a generated enumeration test.
- **The CI pipeline** — real Postgres with migrations and role provisioning in both jobs, a
  genuinely booted production build for e2e, zero secret dependencies, and the required-check
  gate verified by attempting the push it must refuse.
- **Register and process discipline** — closures citing commits, CI URLs, and red-before-green
  proofs; the 2026-08-12 triage is genuinely strong self-audit; the register is functioning as
  memory, not sediment (~20 open rows actionable now), though its medium is straining (§7).
- **First-run product path** — registration bootstraps a complete tenant atomically; honest
  empty states route to first value; Africa-contextual placeholders; above-typical a11y
  fundamentals in most interactive components; legal pages honestly labelled as drafts.

## 6. Verification downgrades — the audit auditing itself

Six Highs were downgraded to Medium under adversarial re-examination, and one was narrowed:
**AC-01** (D-185 stale-GET overwrite: production build issues exactly one GET per mount; the
deterministic trigger is dev-only StrictMode); **PT-04** (no password reset: real, but D-048
already tracks it, re-targeted to Phase 2 with justification — the "no row exists" claim was
false); **DEP-09** (production email: gaps real, impact claim inflated — invites degrade to
copy-link, not 500); **TEN-01** (the `prisma migrate dev` DROP of `evidence_dedup_key`:
reproduced exactly, but the vector cannot currently fire because `migrate dev` is itself broken
on this branch — D-109 — making this an armed trap behind another defect rather than a live
gun); **PH-1** (D-018 staleness: a structural fragility reading, not a demonstrated
contradiction); **QG-1** (lint-red-as-found: real and reproduced, but self-healing and
residue-caused). **T-02** stayed High with two supporting claims corrected. Zero findings were
refuted outright — and the fact that the refutation pass *changed* six severities is evidence
it was a real pass, not a ritual.

## 7. Process findings — is the machine that builds this working?

- The process catches real defects and its evidence discipline is real (§5). Its cost is high —
  roughly half of recent commits are bookkeeping — but most of that cost demonstrably pays.
- The register (210 rows, 523KB, single-line rows up to 7KB) is **straining its medium**: three
  pipe corruptions to date, narratives migrating between columns, vocabulary drifted in both
  directions from its own legend (26 rows in undeclared kinds; header vs integrity-test
  disagreement), and — decisive — **every sweep filters by one target label, and the misses
  are now systematic** (PH-2, PH-6, and the triage doc's own record of the same failure).
- Two register rows were caught asserting falsehoods (D-037's "provisional marker" that never
  existed — ENG-05; D-117's engine claim — PT-02). This is the register's known worst failure
  mode (D-068, "laundered deferral") occurring in the wild, twice.
- The mandatory `what-if-oracle` rule has not fired at the project's largest pending fork (the
  collaboration-model restructure) — it is named as mandatory in the proposal doc itself (PH-7).
- A ruled decision ("add jsdom") is recorded in one column of a row whose other columns still
  say the decision is untaken; the package is not installed six days later (PH-3, T-06).
- 26–28 open rows gate on D-018 "hosting: parked" while the repo maintains VPS runbooks and a
  VPS now exists — the register's single biggest gate is out of sync with reality (PH-1).

## 8. What this audit could not establish — the honest boundary

From the coverage critic, kept verbatim in substance:

1. **Nothing was executed live, anywhere.** Every Critical/High — including the deploy-DOA
   chain and all race findings — rests on static reading plus targeted command reproduction.
   The project's own doctrine defines done as live verification; by that standard this audit's
   claims are strong hypotheses with unusually good evidence, not driven proof. A live pass
   (boot the prod compose, walk the app, run the races) could reprice the headline in either
   direction.
2. **The framework content — the actual product payload — was audited by no dimension.** The
   78 questions / 21 areas / 28 controls (~144KB) and their fidelity to NIST/UNESCO/EU-AI-Act
   sources are register row D-032's scope and remain unexamined. For an RAI tool, wrong
   guidance is a correctness defect no amount of RLS rigor offsets.
3. **The cross-assessment analytics surface (dashboard, compare page, trend/heatmap/radar
   components) had no owner** — and it presents numbers computed by an engine with confirmed
   scoring defects.
4. **Mutual-deferral orphans:** `scrubUserOnDeactivation`, invitation-token redemption
   internals, `proxy.ts` in full, and `lib/security-logger.ts` were each deferred by every
   adjacent auditor to a dimension that did not exist — reproducing, at audit level, the exact
   D-063 seam failure the project's rules document.
5. **The SPA→platform cutover was walked by nobody.** The primary adopter uses the live SPA
   today; there is no import path, no comparability statement, and an unmanaged engine fork
   between two live products that can silently diverge in scoring (DEP-6).
6. **Injection/output-encoding was examined nowhere as a class** — R-02 (CR/LF-capable names
   reaching the PDF header unsanitized) proves the class is live.
7. **~150 register rows and ~5 large spec documents were never read end-to-end** by any
   auditor — the two deep-read methods with proven yield in this very audit.

## 9. Where this points (input to the separate replan — not decisions)

The replan is a separate deliverable. But the findings themselves order the work:

1. **A "make the truth true" pass** dominates everything: deploy-path repair proven by an
   actual VPS deployment; the silent-loss cluster in the assessment client; ENG-01; the false
   promises (privacy page, forgot-password copy, remediation facade, D-037/D-117 corrections).
2. **Live execution as the audit's own completion condition:** the confirmed findings should
   be re-proven or re-priced by driving the real system — which is also the project's doctrine.
3. **The register needs a structural intervention**, not another sweep with one filter.
4. **The vision document needs to be re-grounded** against what exists, or it will keep
   mis-sequencing work (its §8 still calls hosting "deferred" while a VPS sits procured).

*Report generated from 17 auditor results + 16 adversarial verifiers + 1 coverage critic
(~9M tokens of investigation), merged mechanically; synthesis by the session controller.
Raw structured results preserved outside the repo in the session workspace.*
