<!--
PRESERVED FROM A SCRATCH WORKSPACE, 2026-08-12.

This document was produced as `task-4-derivation.md` inside the git-ignored
SDD workspace `.superpowers/sdd/2026-08-10-phase1d-i-e2e-trustworthy/`, which
the subagent-driven-development process deletes once a plan's work is merged,
on the reasoning that git history is the record.

It is committed here instead because `lib/rate-limit.ts` cites it in
production code as the justification for a security value -- the registration
cap of 50, and the finding that the control is not adversarial at any value.
A citation to a deleted file looks like evidence, passes review, and cannot be
followed. See register row D-207 for the wider problem: four earlier citations
into deleted Phase 1b and 1c workspaces are already dangling.

Nothing below has been edited. Section references (S2.2 and so on) match the
numbering `lib/rate-limit.ts` points at.
-->

# Task 4 — Fresh threat derivation: `POST:/api/auth/register` rate limit

**Control under derivation:** `lib/rate-limit.ts:21`
`'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 5, keyBy: 'ip' }`

**Register row:** D-195 (Open, Step 1 = this pass).
**Date:** 2026-08-10. **Branch:** `phase1d-i-e2e-trustworthy`.

**This document changes nothing.** No file under `lib/`, `app/`, `proxy.ts`, `e2e/` or `docs/` was
edited. `git status --porcelain --untracked-files=all` is empty at the time of writing; the only
artifact produced is this file, inside the gitignored SDD workspace. The human partner rules on the
outcome.

**Skills invoked:** `engineering-skills:senior-security` (the §7.1 preventive instrument, read in
full before deriving), `what-if-oracle` aimed at the *decomposition* per AGENTS.md §3.5 / the
SKILLS_INVENTORY §2 enumeration row, and `rigor-loop` framing throughout. Not invoked, and why, in
§11.

**Derived fresh.** No table from the Task 2/3 email-transport derivation was reused, consulted, or
adapted. Re-deriving found three things that derivation could not have contained, all in §2.

---

## 0. Method and evidence standard

Everything load-bearing below is either (a) a file:line I read, (b) a command I ran with its output
pasted, or (c) explicitly marked as inherited/unverified. The most dangerous claims in a document
like this are the ones generated to explain an obstacle (AGENTS.md §5), so the two central claims —
"the cap is 5 and it bites" and "the key is spoofable" — were both driven through the **real running
application**, not reasoned about and not tested at the unit boundary only.

**Live rig.** `docker-postgres-1` was already up (healthy, 3 days). I started `npm run dev`
(`✓ Ready in 303ms`), ran the probes in §2 and §3, then killed it and confirmed
`curl -o /dev/null -w "%{http_code}" http://localhost:3000/login` → `000`. No rows were created by
any probe: every probe payload fails server-side validation and returns 400 *after* the limiter has
already counted it — which is itself one of the findings (§3.3).

**Mid-task observation, reported not corrected (AGENTS.md §2, "an assumption in the brief turns out
to be false" / §4).** The working tree moved underneath this derivation while it ran: HEAD went
`c199fd7` → `70e00c0` (5 commits: `b53efb0`, `6a47fbf`, `4be4524`, `45202d6`, `70e00c0`), and the
three modified files plus one untracked test present at dispatch are gone from
`git status`. I re-read the control afterwards to confirm I had not derived against a stale file:
`lib/rate-limit.ts:21` still reads `max: 5`, and `proxy.ts:66-70` is unchanged. The derivation
stands. Flagging it only because AGENTS.md §4 makes committing during a subagent's run the
controller's own named hazard.

---

## 1. Corrections to the brief, before anything is built on it

Four statements in the dispatch do not survive checking. Two of them **strengthen** the case for
change; one **weakens** part of it; one is cosmetic. All four matter because the fix will be
justified by these numbers.

### 1.1 "The cap was hit exactly once during the full e2e suite" — **not established, and almost
certainly false. The real figure is five refusals, not one.**

The single log line cannot bear that reading. `proxy.ts:170` gates `RATE_LIMIT_EXCEEDED` on
`result.firstRefusal`, and `lib/rate-limit.ts:202` defines
`firstRefusal: entry.count === config.max + 1` — true at count 6 and **never again in that window**.
The gating was deliberate (a `code-review` finding about log amplification; the comment at
`proxy.ts:164-172` says so). So **one line means "at least one refusal in this bucket-window", and
places no upper bound at all.**

Counting the suite's actual register traffic, generated from disk rather than from the register row:

| Spec | `POST /api/auth/register` calls | Evidence |
|---|---|---|
| `e2e/auth.spec.ts` | 1 | `auth.spec.ts:10-29`, form-driven |
| `e2e/org-routing.spec.ts` | 3 | `registerAndLogin` called at `:53`, `:84`, `:92` |
| `e2e/project.spec.ts` | 1 | `registerAndLogin` at `:42` |
| `e2e/security.spec.ts` | 5 | `:98-115`, an explicit `for (let i = 0; i < 5; i++)` |
| `e2e/security.spec.ts` ×3 "rejects…" tests | **0** | `:6`, `:14`, `:30` never reach the network — `required`, `minLength={8}` and `type="email"` on `app/(public)/register/page.tsx:47-57` make the browser block submit |
| `e2e/two-orgs.spec.ts` | **0** | see §1.2 |
| `evidence-lifecycle`, `role-matrix` | 0 | consume `storageState` from `auth.setup.ts` |
| **Total** | **10** | against a budget of **5** |

Execution order, from `npx playwright test --list` with `fullyParallel: false`
(`playwright.config.ts:5`): `assessment-flow` (currently `test.fixme`), `auth`,
`evidence-lifecycle`, `org-routing`, `project`, `role-matrix`, `security`, `two-orgs`.

That puts registrations #1–#5 in `auth` + `org-routing` + `project`, and makes
`security.spec.ts`'s **first** POST request #6 — the exact request that trips `firstRefusal` and
emits the one observed line, "immediately before" that test's assertions, precisely as reported.
Requests #7–#10 are also refused and log nothing.

**So the headroom is not zero. It is −5.** All five of `security.spec.ts`'s registrations are
already being refused today, and the suite is green because that test is vacuous under refusal: on
a 429 `proxy.ts` sets `X-RateLimit-Remaining: '0'`, so `remaining >= 0` holds, and the assertion
chain becomes `0 ≤ Infinity`, then `0 ≤ 0`, forever. **A test written to observe the rate limit
passes identically whether the limiter works, is absent, or refuses every request.**

*Confidence: high, but this is an inference from three verified inputs (the call count, the
`--list` order, the `firstRefusal` gate), not an observation of the CI log. **Falsification test:**
re-run the CI job with the `firstRefusal` gate temporarily lifted, or assert
`expect(response.status()).toBe(201)` in `security.spec.ts`'s loop; if the headroom is really zero
rather than −5, all five return 201.*

### 1.2 `e2e/two-orgs.spec.ts`'s "Create Account" is **not** this control's traffic

D-195 lists it as one of the four register drivers. It is the **invitation** registration form
(`two-orgs.spec.ts:131-136` fills `#inv-name`, `#inv-password`, `#inv-confirmPassword`), which posts
to `POST /api/v1/invitations/[token]/register`. That path matches no `RATE_LIMITS` key and falls to
`'default'`. Measured, not assumed (§2.4). The register row's file list should lose this entry — and
gain the observation in §2.4, which is considerably more interesting.

### 1.3 `resetRateLimit()` is `resetRateLimitStore()`, and it is no longer dead code

`lib/rate-limit.ts:207`. D-124 described it as "currently dead code with zero callers"; it now has
two test consumers (`__tests__/unit/rate-limit.test.ts:2`,
`__tests__/unit/proxy-rate-limit-logging.test.ts:3`). Still no production or e2e caller — which
keeps option (g) in §8 live.

### 1.4 The adopter claim: **substantially true, but it is not in the plan of record**

The dispatch asked me to check this rather than inherit it, and the check produces a nuance worth
putting in front of the human partner.

- **`docs/VISION_AND_PLAN.md` §3.1 and `AGENTS.md`'s "Decisions locked" both say the primary adopter
  is "team self-improvement"** — an adopter *class*, with no geography in it.
- The African context is locked at **§3.2, as a standards anchor** ("at least one anchor must be
  tailored to the African / Global South context", AU Continental AI Strategy, non-negotiable).
- The phrase **"the primary adopter is African university teams"** appears in
  `lib/data/preauth.ts:388`, in `__tests__/integration/bootstrap.test.ts:43`, and in D-112 — never in
  `VISION_AND_PLAN.md`. `bootstrap.test.ts:43` attributes it to `AGENTS.md`, **which does not say
  it.** That is a live doc-drift finding, incidental to this task.
- The deployment-context claim the argument actually needs is, however, locked, and in the strongest
  available place: **`docs/adr/0002-identity-and-account-linking.md:127`** — *"The idle timeout
  matters more than usual in the target context — **shared lab machines and intermittent
  connectivity** make a long-lived session on a walked-away-from browser the realistic exposure."*
  That is the Ψ finding the dispatch referred to, and it is load-bearing in a merged ADR.

**Verdict:** the reframe survives. The deployment context — institutional, shared-machine,
shared-network — is established in an ADR and acted upon elsewhere in the codebase. The specific
words "African university teams" are established in code comments and the register, not in the plan
of record. If the human partner wants the register row to lean on the adopter argument, the honest
citation is **ADR-0002:127 plus VISION_AND_PLAN §3.2**, not §3.1.

**One thing the dispatch's framing understates.** D-018 (hosting) is **PARKED, Open**. There is no
deployment, so *no colleague has been locked out yet.* This is a defect that is certain to bite on
first contact with a real workshop, not one currently harming anyone. That matters for §8: it means
there is time to choose correctly, and it means every option whose correctness depends on knowing
the network topology is blocked by the same thing that blocks D-124 and D-125.

---

## 2. Q2 first — is `keyBy: 'ip'` meaningful?

I answer this before Q1 deliberately, because the answer changes what Q1 can even be asking.

### 2.1 The identifier's provenance

`proxy.ts:66-70`:

```ts
  // Extract IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';
```

Two client-settable headers, first-listed value taken, no trusted-proxy allowlist, no comparison
against the transport-layer peer address, no environment flag distinguishing "behind a proxy" from
"directly exposed". That `ip` is passed unmodified to `checkRateLimit(method, pathname, ip, userId)`
(`proxy.ts:144`), where `identifier = config.keyBy === 'userId' && userId ? userId : ip`
(`lib/rate-limit.ts:150`). For a `keyBy: 'ip'` rule on a pre-auth route there is no `userId` to fall
back to, so **the bucket key is a string the caller chooses.**

### 2.2 Live proof through the real proxy

Not asserted — driven. Both blocks below are real `curl` output against `next dev` on
`localhost:3000`, payload `{"name":"probe","email":"not-an-email","password":"x","termsAccepted":true}`
(400s, so no rows written; the limiter runs in `proxy.ts` *before* the handler validates anything):

```
=== A: 7 POSTs, SAME x-forwarded-for (198.51.100.7) ===
limit=5 remaining=4 req#1 status=400
limit=5 remaining=3 req#2 status=400
limit=5 remaining=2 req#3 status=400
limit=5 remaining=1 req#4 status=400
limit=5 remaining=0 req#5 status=400
limit=5 remaining=0 req#6 status=429
limit=5 remaining=0 req#7 status=429

=== B: 7 POSTs, each a DIFFERENT x-forwarded-for (203.0.113.1 … .7) ===
limit=5 remaining=4 req#1 status=400
limit=5 remaining=4 req#2 status=400
limit=5 remaining=4 req#3 status=400
limit=5 remaining=4 req#4 status=400
limit=5 remaining=4 req#5 status=400
limit=5 remaining=4 req#6 status=400
limit=5 remaining=4 req#7 status=400
```

Block B never leaves `remaining=4`. **Every request minted a brand-new budget for the price of one
HTTP header.** At the unit boundary the same shape scales without limit — `checkRateLimit` accepted
**500 of 500** register requests across 500 distinct spoofed addresses
(`tsx` probe against the real module, scratchpad `probe.ts`).

### 2.3 What that means for the number

**The `5` bounds only clients that do not lie.** Against an adversary the control's strength is not
"5 per 15 minutes"; it is **unbounded**, gated by nothing but the attacker's willingness to type
`-H 'x-forwarded-for: …'`. The number therefore governs exactly one population — *honest clients
sharing an address* — which is precisely the population the NAT argument is about. Every abuse
number in §4 must be computed with the cap set to infinity, and every usability number in §5 with it
set to 5.

This is not new information to the project; it is D-124's second half, widened by a `simplify` pass
on 2026-08-04 and re-affirmed on 2026-08-08 as "CONFINED to genuinely pre-auth traffic (`keyBy: 'ip'`
rules: `POST:/api/auth/register`, `POST:/api/auth`), where it remains fully live". What is new is
the direct measurement on **this** route, and the consequence: **the D-195 debate is not "is 5 the
right security number?" It is "what is the right *ergonomics* number for a control that provides no
adversarial guarantee at all?"** Those are different questions with different owners, and conflating
them is how a security control's value gets set by a test suite (§9, ∞).

### 2.4 A finding this derivation was not sent to look for

The dispatch pointed me at one route. Varying the *root* rather than the predicate (AGENTS.md §3,
decomposition rule 2) — "what **other** path creates a `User`?" — reaches
`POST /api/v1/invitations/[token]/register`, which calls `createUserFromInvitation` and writes the
same consent trio (`lib/data/preauth.ts:186-196`). Measured against the real module:

```
self-serve register       : limit=5  firstRefusedRequest=#6
invitation register       : limit=60 firstRefusedRequest=#61
login callback            : limit=15 firstRefusedRequest=#16
rotated-token, ONE ip     : 500/500 invitation-register requests ACCEPTED
```

Two things fall out. First, the sibling account-creation path carries a cap **180× more permissive
per unit time** (60/min vs 5/15min) purely because nobody wrote a `RATE_LIMITS` entry for it — it
lands on `'default'`. Second, because non-wildcard keys still bucket by the **raw literal path**
(`lib/rate-limit.ts:176-178`; the un-fixed remainder of D-151, carried as **D-153**), the token
segment mints a fresh budget: **500/500 accepted from a single IP without touching a header.**

The practical harm is small — `invitationByToken` runs first
(`app/api/v1/invitations/[token]/register/route.ts:28`) and a bogus token 404s before any bcrypt or
write, so an attacker gets one indexed lookup per request rather than an account. But it is worth
recording plainly: **if the cap on `/api/auth/register` is raised on the argument that "5 is too
tight for a workshop", the same argument applies to a sibling path that is already effectively
uncapped, and the asymmetry between them is an accident, not a decision.** It also means the
workshop scenario in §5 needs splitting: *joining an existing org* does not touch this control at
all.

---

## 3. Q1 — what does this control actually defend, and what does the attack cost?

### 3.1 What one registration buys the attacker

`bootstrapOrgWithOwner` (`lib/data/preauth.ts:155-175`), one transaction on the **owner
(BYPASSRLS)** connection:

- 1 `User` — `isActive` defaults **`true`** (`prisma/schema.prisma:77`), `mustChangePassword`
  defaults `false`. **No approval step, no activation step.**
- 1 `Organization` with a server-derived unique `slug` (`deriveSlug`, `lib/data/preauth.ts:411`)
- 1 `Membership` at role **`owner`** (`createOwnedOrg`, `:378`)
- 2–3 `ConsentRecord` rows, whose `ipAddress` is the raw client-supplied `x-forwarded-for`
  (`app/api/auth/register/route.ts:64` → `:84`; this is **D-125**, Open)

So one unauthenticated HTTP request yields **a fully live tenant with an owner who can log in
immediately.** There is no rung between "posted a form" and "owns an organization on this platform".

### 3.2 What bounds it *other than* this rate limit — the answer is essentially nothing

Checked, not assumed:

```
grep -rni "captcha|turnstile|hcaptcha|recaptcha|emailVerified|verificationToken|EmailVerification"
  --include=*.ts --include=*.tsx --include=*.prisma . (excluding node_modules)
  → (no output)
grep -rni "quota|limit.*projects|max.*orgs|maxOrgs" lib/ app/api --include=*.ts
  → (no output)
```

| Candidate control | Present? | Evidence |
|---|---|---|
| Email verification / confirm-before-active | **No** | zero grep hits repo-wide; `isActive` default `true` |
| CAPTCHA / proof-of-work / Turnstile | **No** | zero grep hits repo-wide |
| Invitation-only registration mode | **No** | `/register` is public (`app/(public)/register/page.tsx`); the invitation route is an *additional* path, not a gate on this one |
| Admin approval of new orgs | **No** | no such surface |
| Per-account resource quota | **No** | zero grep hits |
| Unique email constraint | Yes | `prisma/schema.prisma:73` — stops *duplicate* accounts, not *many* accounts |
| Password policy | Weak | `lib/validate.ts:28-39` — length 8–128 only, no composition rules |
| Slug-collision DoS resistance | Yes | `createOrgInTx` retries under SAVEPOINT, then one unconditional random slug, "registration must not be deniable by anyone who can cheaply force collisions (D-107)" |

**`RATE_LIMITS['POST:/api/auth/register']` is the entire anti-abuse posture of account creation on
this platform.** And per §2 it does not bind an adversary. The honest statement of the current state
is therefore: **mass registration is presently unbounded, and this control is not what is preventing
it — nothing is. What has prevented it is that D-018 is parked and the app is not deployed.**

### 3.3 What the attack costs — attacker and system

**Server cost per accepted registration:**

```
bcryptjs hash(cost=12) mean ms over 5 runs: 230
=> one CPU-second buys ~4.3 registrations of hashing work
```

`app/api/auth/register/route.ts:63` runs `hash(password, 12)` on the request thread, *after* the
duplicate-email check and *before* the transaction. So per accepted request the server spends
**~230 ms of blocking CPU** plus a 5-statement transaction on the BYPASSRLS pool. Node is
single-threaded per instance: **~4 registrations/second saturates one instance's event loop with
hashing alone.** An attacker rotating `x-forwarded-for` needs roughly 5 concurrent request streams
to make the whole application unresponsive — including to the login of every existing user, because
`proxy.ts` is the choke point for all `/api/*` traffic.

**Attacker cost:** one HTTP request, one fabricated header, one unique email string. No email
receipt, no solved challenge, no cost function of any kind. Note the asymmetry sharpens against the
attacker's favour: a **duplicate** email returns 409 *before* bcrypt (`route.ts:58-61`), so an
attacker who wants to burn CPU simply varies the email — which is also what they want for account
creation. There is no payload the attacker prefers that is cheap for the server.

**And every rejected request still costs the honest user a slot.** Block A above is all `400`s and
the counter decremented on each. Rate limiting runs in `proxy.ts` before the handler, so the budget
of 5 is *5 attempts*, not *5 accounts* (see §5).

### 3.4 STRIDE, applied to this control and its data flow

Trust boundary: unauthenticated Internet → `proxy.ts` → `app/api/auth/register/route.ts` →
owner/BYPASSRLS Prisma client → Postgres.

| | Threat at this element | Present? | Note |
|---|---|---|---|
| **S** Spoofing | Attacker spoofs the *rate-limit identity* via `x-forwarded-for` | **YES — live-confirmed §2.2** | This is the root defect. Not "spoofing a user" — spoofing the *subject of the control*. |
| **T** Tampering | Attacker sets `ConsentRecord.ipAddress` to any string | **YES** | D-125, Open. Tampering with the product's own audit evidence. |
| **R** Repudiation | Consent provenance is client-asserted, so the record proves nothing | **YES** | D-125. Sharpened by this control: the *rate* of poisoning is what the cap governs. |
| **I** Info disclosure | Registration as an existence oracle | Partial | 409 "An account with this email already exists" (`route.ts:60`) is an email-existence oracle; the cap is currently the only thing throttling enumeration of it — and per §2 it does not. Org-slug existence is deliberately *not* disclosed (D-101). |
| **D** Denial of service | (i) resource exhaustion via bcrypt; (ii) **the control itself denying service to honest NAT'd users** | **YES, both** | (ii) is the D-195 complaint. (i) is what the control exists for and cannot do. |
| **E** Elevation of privilege | Registration self-grants `owner` on a new org | By design | Bounded: owner of a *new, empty* org. No cross-tenant reach (RLS + ADR-0001). Not a defect. |

**DREAD, for the two threats that are actually in tension** (1–10 each; this is the trade-off the
human partner is being asked to rule on):

| Threat | D | R | E | A | Di | Score | Comment |
|---|---|---|---|---|---|---|---|
| **T-ABUSE** — mass automated registration / bcrypt exhaustion | 7 | 10 | 9 | 8 | 6 | **40/50** | High *today* in principle; **currently un-mitigated regardless of the cap's value** (§2.3). Not currently exploitable because nothing is deployed (D-018). |
| **T-ONBOARD** — honest sixth colleague locked out behind institutional NAT | 6 | 10 | 10 | 7 | 9 | **42/50** | Fires on first real workshop with certainty, not probability. Damage is to adoption, which §3.1 of the plan makes the primary success criterion. |

The scores land within noise of each other, which is the correct read: **these are comparable-severity
risks, and the current configuration mitigates neither** — it fails T-ABUSE structurally (spoofable
key) while paying T-ONBOARD's full price (honest users share a bucket). That is the worst cell of
the matrix: all of the cost, none of the protection.

---

## 4. Q3 — the NAT question, quantified

### 4.1 The numbers

Under `max: 5, window: 15 min, keyBy: 'ip'`, with an institution behind a single NAT egress address
(`x-forwarded-for` absent or uniformly rewritten by the campus edge — the case where the header is
*not* attacker-varied):

| Question | Answer | Basis |
|---|---|---|
| Colleagues who can **create a new organization** per 15 min, per institution | **5** | live block A |
| …but the budget is spent by **attempts**, not accounts | **5 attempts** | live block A: five `400`s consumed the whole budget |
| What #6 receives | HTTP **429**, body `{"error":"Too many requests. Please try again later."}` | live |
| How long #6 waits | `retry-after: 884` seconds ≈ **14 min 44 s** | live |
| Colleagues who can **join an existing org** by invitation per minute | **60**, per raw path — effectively unbounded (§2.4) | measured |
| Steady-state throughput for a 40-person workshop, all creating orgs | 5 per 15 min → **~2 hours** | arithmetic on the above |

**The failure has a sharper edge than "the sixth person waits".** Because a rejected attempt burns a
slot, a room of people who fat-finger an email, retry a duplicate address, or double-tap submit
consumes the institutional budget without a single account being created. Five typos and nobody
registers for a quarter of an hour.

**But the scenario must be split, and the dispatch's version over-claims.** A workshop where one
person creates the org and everyone else is *invited* never touches this control — that traffic goes
to the invitation route at 60/min (§2.4). The 5-per-15-minutes ceiling bites specifically when
**many people each create their own organization from one network**: a multi-institution training
day, a class exercise where each student or team registers a separate org, or the first day of a
pilot before anyone knows the invitation flow exists. That is a narrower scenario than "the sixth
colleague joining a workshop", and it is still a real and likely one — the register/invite split is
invisible on the landing page, so the default behaviour of a room told "go sign up" is exactly the
pattern that fails.

### 4.2 Is the failure distinguishable from an outage, to the user?

**In wording, marginally. In effect, no.**

The 429 body does reach the screen: `app/(public)/register/page.tsx:30` does
`if (!res.ok) { setError(data.error); return; }`, and the 429 carries
`Content-Type: application/json`, so the user sees *"Too many requests. Please try again later."* in
the `role="alert"` box at `:44`.

What they do not get:

- **No duration.** `Retry-After: 884` is on the response and the client never reads it. "Later" is
  the entire guidance for a 15-minute wait.
- **No cause they can act on.** Nothing indicates that the limit is shared with everyone else on
  their network — which is the one fact that would tell them not to keep retrying, and not to
  conclude the platform is broken.
- **No alternative path.** Nothing points at "ask a colleague to invite you", which would work
  immediately (§2.4).
- **Retrying makes it worse.** Refused requests keep incrementing `entry.count`
  (`lib/rate-limit.ts:188` runs before the `success` computation), so `resetAt` is a fixed 15 min
  from bucket creation but the user has no way to know their retries are futile.

For a first-time visitor in a room where several colleagues just hit the same wall simultaneously,
"Too many requests. Please try again later." on the sign-up page of a platform they have never used
is operationally indistinguishable from "this thing does not work". The distinguishability question
in the dispatch has a worse answer than it may have expected: **the message is technically honest and
practically useless**, and any option chosen in §8 should be paired with a UX change, because raising
a number does not fix the case where the raised number is also exceeded.

---

## 5. Reach (AGENTS.md §3) — what else touches this decision

Asked before proposing anything, because the fourth question is the one that keeps not getting asked.

- **What reads this value?** `findConfig` → `checkRateLimit` (`lib/rate-limit.ts:93-109`), one
  production caller, `proxy.ts:144`. Plus `__tests__/unit/rate-limit.test.ts` and
  `__tests__/unit/proxy-rate-limit-logging.test.ts`, which import `RATE_LIMITS` directly, and
  D-195's own O-10 obligation, which is specified to *generate* the expected e2e count from this
  file.
- **What writes it?** Nothing. It is a module-scope literal with no env override —
  `grep -n "process.env" lib/rate-limit.ts` → *(none)*. There is **no precedent anywhere in `lib/`**
  for environment-gating behaviour (`grep -rn "process.env.NODE_ENV\|E2E\|CI" lib/*.ts` → *(none)*),
  so option (d) in §8 introduces a new pattern rather than following one.
- **What did the current design make possible that nothing else notices?** The store is a
  per-process `Map` (`lib/rate-limit.ts:42`). **The effective production cap is `max × instance
  count`, and the instance count is undefined because hosting is parked.** Whatever number is chosen
  is therefore a per-instance number, not a system number — already recorded in AGENTS.md §3's own
  list of interaction defects ("rate limiting worked but its in-memory store broke under
  multi-instance hosting").
- **What happens on paths not touched?** `POST:/api/auth` (login, 15/15min) shares the identical
  spoofable identifier and the identical NAT exposure — D-124's original subject, still open, and
  the reason `auth.setup.ts` spoofs 20 addresses. Any principle adopted here for `register` applies
  to `auth` by exactly the same argument, and leaving them inconsistent is a decision, not a default.

**Judging `e2e/fixtures/auth.setup.ts`'s argument, as asked.** Its module doc (`:41-61`) says the
per-seat synthetic `x-forwarded-for` "does not defeat the control against its actual target (many
rapid attempts from ONE real client); it corrects an artifact of the local test topology."

**The argument is sound on its own terms and I would not change the file.** Twenty Playwright
contexts sharing one loopback socket genuinely is a test artifact; twenty real users on twenty
machines genuinely would not collapse to one address; and the file is scrupulous — it root-caused
the 429 live, it declined to touch `proxy.ts`, and it opened D-124 for the real finding rather than
quietly working around it. That is the process working.

**But the argument has aged into something it does not say.** It rests on "the control still binds
its actual target", and §2.2 shows the control binds *no* adversarial target, because the same header
the fixture sets is the one an attacker sets. The fixture is not bypassing a control that holds for
others — it is using, for a legitimate purpose, an escape hatch that is open to everyone. That does
not make the fixture wrong. It does mean **the fixture cannot be cited as evidence that the control
is sound**, and D-124's own text (2026-08-08) already reaches this conclusion. Worth stating because
a reader could reasonably take "this is not a security-control bypass" as reassurance about the
control, which it is not.

---

## 6. Q4 — options and trade-offs

**I am not picking one.** The dispatch's three options all answer *"what number or dimension should
`lib/rate-limit.ts` use?"* — one lens, one search root. Generating the list again from a different
root — *"what could bound registration abuse **at all**, including things that are not the rate
limiter?"* — reaches (d)–(g), which are not variants of (a)–(c) and are not substitutes for each
other. Per AGENTS.md §3 that second generation is obligatory, not optional; it is what turns three
options into seven.

Throughout: **no option in this table changes the fact established in §2 — an adversary bypasses the
per-IP dimension with one header.** Options (a), (c), (d), (g) leave adversarial protection at zero
by construction. Only (e) and (f) change it, and (b) makes one part of it worse.

---

### (a) Raise the per-IP cap

**Shape.** `max: 5` → a NAT-tolerant value.

**What value, and why.** The honest answer is that no value is derivable from evidence, because the
population it must serve is unmeasured and D-018 means it cannot yet be measured. What *can* be
derived is a floor and a ceiling:

- **Floor ≥ 15.** The e2e suite drives 10 register attempts in one bucket-window (§1.1). Anything
  below ~15 leaves the suite with no slack for a single added registering test — which is the exact
  landmine D-195 exists to defuse.
- **Floor ≥ ~40–50 for the product scenario.** A 40-person cohort each creating an org, with a
  realistic ~1.3 attempts per person (typos, duplicates, double-submits — remember attempts are what
  count, §4.1), needs ~50 in the window to complete without a stall.
- **Ceiling from CPU, not from abuse.** 50 accepted registrations × 230 ms ≈ **11.5 CPU-seconds per
  IP per 15 minutes** — negligible. The CPU ceiling is not reached until the low hundreds, and since
  the key is spoofable, the per-IP cap was never the CPU bound anyway (§3.3).

So **50 is defensible and 15 is the minimum that discharges D-195's stated purpose** — and both are
judgement calls of the same kind as ADR-0002's `maxAge` ("judgement calls with no usage data behind
them. Recorded as tunable, revisited after the first pilot"). That precedent is the honest model for
this decision.

**Abuse admitted.** *Against an adversary: none, because the current setting admits all of it
already.* Against accidents: a runaway client loop from one honest address gets 10× further before
being stopped, ~11.5 CPU-seconds instead of ~1.15.

**Cost.** One integer. Minutes.

**What must be true for this to be right.** That the cap's only real job is protecting honest clients
from accidents and the platform from accidental loops — i.e. that adversarial protection is
explicitly acknowledged as *not provided here*, and is owned by a separate, named future control.
If that acknowledgement is not written down, this option quietly re-labels a broken control as a
tuned one.

---

### (b) Two dimensions: looser per-IP burst + a global/window cap

**Shape.** e.g. 50/15min per IP, plus a platform-wide ceiling of N registrations per window.

**Abuse admitted — and a regression the dispatch's framing does not surface.** A global bucket is
*shared*, and the per-IP dimension is *spoofable*. An attacker rotates `x-forwarded-for` to walk past
the per-IP dimension and then **exhausts the global bucket**, at which point **registration is denied
to every institution on the platform simultaneously.** The global cap converts a per-institution
availability failure into a **global** one, and hands the attacker a cheaper denial-of-service than
they have today. Under a spoofable identifier, a global cap is not defence-in-depth; it is an
amplifier.

This is the `what-if-oracle` ∞ Second-Order result for this branch, and it is the single strongest
reason not to reach for (b) first.

**Cost.** Meaningful: a second bucket dimension in `checkRateLimit`, a second config shape, and —
because the store is per-process — a *global* cap that is not actually global under any multi-instance
topology. It would need shared state (Redis/Postgres), which is blocked on D-018.

**What must be true for this to be right.** That the per-IP dimension is first made
**non-spoofable** (option (e)); a global cap layered on a trustworthy per-IP key is a reasonable
control, and layered on a forgeable one it is a liability. **(b) is coherent only as a successor to
(e), never as an alternative to it.**

---

### (c) Leave it; record the onboarding failure as an accepted risk

**Abuse admitted.** Unchanged. Onboarding failure retained, and — per §1.1 — the e2e suite remains
5 registrations *over* budget with a vacuous test papering over it, which is the specific condition
D-195 was opened to prevent and which the human partner has already ruled must be fixed *inside*
Phase 1d-i ("the phase which arms the gate clears the chamber").

**Cost.** A register row.

**What must be true for this to be right.** That the human partner reverses that ruling. **On the
evidence in §1.1 this option is strictly worse than it looked when D-195 was written**, because the
premise "zero headroom" is actually "−5 headroom, concealed by a test that cannot fail". Leaving it
also leaves a test asserting nothing under a check about to become blocking.

---

### (d) Make the value environment-configurable

**Shape.** `max` read from an env var with the current value as default; CI/e2e sets a generous
value, production keeps a chosen one.

**Abuse admitted.** None beyond (a) — *provided the production default is the safe one and the
override is additive-by-configuration, never by request content.*

**Cost.** Small, but it introduces a pattern that does not currently exist anywhere in `lib/`
(§5), and a misconfigured deployment silently gets the wrong security posture with no signal. Wants
`env-secrets-manager` (SKILLS_INVENTORY §2) at implementation time.

**What must be true for this to be right.** That the test suite's needs and production's needs are
genuinely different numbers. **They are** — and this is the option that directly answers the ∞
finding in §9: it gives the two numbers two different owners, so a future test cannot raise the
production cap as a side effect of being added.

---

### (e) Fix the key, not the number

**Shape.** Three sub-variants, ranked by dependency:

- **(e1) Trusted-proxy allowlist** — honour `x-forwarded-for` only from configured upstream
  addresses; otherwise use the transport peer. **Blocked on D-018**: this is precisely the fix D-124
  and D-125 both name and both decline for the stated reason that there is no topology to trust
  against. Choosing a trust boundary with no deployment is guessing.
- **(e2) Composite key, e.g. `ip + email`** — named in D-124 as a candidate. Cheap and unblocked.
  Helps the NAT case genuinely: five colleagues with five different emails get five buckets. But it
  is **trivially defeated** by an attacker, who varies email anyway, so it *only* improves ergonomics
  — it must not be described as tightening the control. It also **weakens** the email-enumeration
  throttle in §3.4/I, since each probed address gets its own budget.
- **(e3) Collapse the store key** — extend the D-151 fix to non-wildcard keys, closing **D-153** and
  the §2.4 invitation-token finding.

**Cost.** (e1) blocked; (e2) small; (e3) moderate with a real reach assessment across every route
under `'default'` — explicitly out of scope of the task that opened D-153.

**What must be true.** For (e1): hosting decided. For (e2): that improving honest-user ergonomics
without changing adversarial strength is understood and stated as such.

---

### (f) Add the control that is actually missing — email verification (or a challenge)

**Shape.** New accounts inactive until an emailed link is followed; or a CAPTCHA/proof-of-work on the
register form.

**Why it belongs in this table.** This is the `what-if-oracle` **Φ Contrarian** result, and it is the
option the dispatch's framing structurally cannot reach: the consensus premise is "the cap is the
wrong number", and the contrarian reading is that **the cap is the wrong *control*.** §3.2 shows it
is carrying the entire anti-abuse posture of account creation alone, which no rate limiter keyed on a
client-supplied header can do. With verification in place, the cap's value stops being load-bearing
and (a) becomes safe at any generous number.

**Abuse admitted.** Substantially reduced: mass registration then costs mailbox control per account.
Does not fix bcrypt exhaustion (hashing happens before any verification could).

**Cost.** Real, and the largest in this table — a schema column, a token table, a mail send, a
verification route, a login gate, and UX. **But the transport seam already exists**: this branch has
an email transport (`RESEND_API_KEY`, exercised by `two-orgs.spec.ts`) and an invitation-token
pattern with sha256 `tokenHash` storage (D-097) that a verification token can copy. The cost is a
task, not a phase — and asserting otherwise without scoping it would be the §5 "effort claims are
claims" failure.

**What must be true.** That Phase 1d-i's scope can absorb it, or — more likely, and the honest
reading — that it is **not** 1d-i's work but must be an explicit, dated register row rather than an
unstated assumption, because every other option in this table is only defensible if something
eventually plays this role.

---

### (g) Reduce the suite's registration count, or reset the store between spec files

**Shape.** Consolidate the 10 register calls; and/or wire `resetRateLimitStore()` (§1.3) to a
test-only reset path.

**Abuse admitted.** None in production — **unless** the reset path ships reachable. A test-only
endpoint that clears rate-limit state is a remote un-limiter if it ever escapes its gate, and that is
exactly the "fallback / default value" shape that fires the §2 `silent-failure-hunter` trigger.

**Cost.** Low for consolidation; the reset path is small but security-sensitive.

**What must be true.** That D-195 is read as a *test-hygiene* problem. **It is not** — the human
partner already ruled it a production defect, and §1.1/§4.1 support that. (g) is a legitimate
*complement* to (a)/(d) (fewer registrations is good hygiene regardless) and an illegitimate
*substitute* for them.

---

### 6.1 How the options relate — the part a list of options cannot show

AGENTS.md §3: *"a list's correctness is entirely in its relations."* These seven are not
alternatives on one axis. They sit on **three independent axes**, and a complete answer picks on each:

| Axis | Question | Options |
|---|---|---|
| **Ergonomics** — what honest shared-network users experience | how many attempts per window? | (a), (d), (e2), (g) |
| **Adversarial** — what an attacker is bounded by | is the identifier trustworthy? is there a cost function? | (e1), (f) — and **only** these |
| **Governance** — who owns the number over time | can a test change a security value? | (d) |

Reading the dispatch's (a)/(b)/(c) as the option space means choosing only on the **ergonomics**
axis and leaving the other two at their current values — adversarial protection *zero*, ownership
*whoever edits the file next*. That is the decomposition defect this section exists to surface, and
it is why (b) is a trap: it *looks* like an adversarial-axis move and is in fact an ergonomics-axis
move that degrades availability.

---

## 7. Q5 — proof obligations, in D-191 form

For each option: the **property** in plain words, what a test must **cause**, and — the part D-191
insists on — **whether passing the test entails the property, or whether the property could be
violated by another mechanism while the test still passes.**

A test that reads `RATE_LIMITS['POST:/api/auth/register'].max` and asserts a number discharges
nothing: it proves the file contains a literal. It cannot see `proxy.ts` failing to pass the value,
the store bucketing by something else, `keyMatches` resolving a different entry, or the header making
the whole key meaningless. Every obligation below is written to be violated by exactly those.

### (a) Raise the cap

- **Property:** *N distinct honest people sharing one egress address can each create an organization
  within one window.*
- **Test must cause:** N+1 real HTTP `POST /api/auth/register` **through `proxy.ts`**, all carrying
  the **same** `x-forwarded-for`, each with a distinct valid payload; assert requests 1..N return
  **201** and N+1 returns **429**. Both halves are required — asserting only the 201s permits a
  removed limiter, asserting only the 429 permits an off-by-N.
- **Entailment gap:** passing does **not** establish the property under multi-instance hosting (the
  `Map` is per-process, §5), nor that the value is right for any real cohort. **Name both; do not
  close them.**
- **Vacuity guard, mandatory:** the existing `security.spec.ts:98` test passes under every possible
  limiter behaviour (§1.1). Any new test must be shown to **fail** against the current `max: 5`
  before it is trusted — red before green, and this is the concrete instance where skipping it would
  reproduce the defect.

### (b) Global dimension

- **Property:** *aggregate registrations across all IPs are bounded in a window* — **and** *no single
  actor can consume the global budget and deny registration platform-wide.*
- **Test must cause:** (i) requests from **many distinct** `x-forwarded-for` values exceeding the
  global cap; assert the cap binds. (ii) **The adversarial half:** one actor rotating headers, then
  a *fresh, previously-unseen* address attempting a legitimate registration; assert it **succeeds**.
- **Entailment gap:** test (i) alone is the trap — it passes precisely when the amplification in §6(b)
  is present. **A (b) implementation whose test suite contains only (i) must be treated as
  unverified.** And a per-process `Map` cannot satisfy "global" at all under >1 instance; a passing
  test on one process is evidence about one process.

### (c) Leave it

- **Property:** *the risk is recorded with a trigger that will actually fire.*
- **Test must cause:** nothing executable — but the register row must state the **−5** figure from
  §1.1, not "zero headroom", and must record that `security.spec.ts:98` currently asserts nothing.
- **Entailment gap:** a row is not a control. Also, `trigger-enumeration.test.ts` **cannot** catch a
  regression here, because it greps for mechanisms and the mechanism is present and configured wrong.

### (d) Environment-configurable

- **Property:** *production runs the intended value even when the override is absent, malformed, or
  hostile.*
- **Test must cause:** boot with the var **unset** → assert the effective limit equals the production
  default (not `NaN`, not `Infinity`, not `undefined`); boot with `"abc"`, `"0"`, `"-1"`, `"1e9"` →
  assert each is rejected or clamped, and that a rejected value falls back to the **safe** default,
  loudly.
- **Entailment gap:** unit tests on a parser do not establish what the **deployed** process reads. A
  `parseInt` fallback is textbook `silent-failure-hunter` territory — dispatch it (pull its output
  from file; do not await it).

### (e1) Trusted-proxy allowlist

- **Property:** *`x-forwarded-for` changes the bucket only when the request arrives from a configured
  upstream; otherwise the transport peer decides.*
- **Test must cause:** identical request pairs differing only in `x-forwarded-for`, from a
  non-allowlisted peer → assert they **share** a bucket (the second sees a decremented `remaining`);
  from an allowlisted peer → assert they **do not**.
- **Entailment gap:** the "shares a bucket" assertion is the one that matters and the one easiest to
  fake — assert on the observed `X-RateLimit-Remaining` **decrementing**, not merely on a 429
  eventually appearing, which a global cap or an unrelated limiter would also produce.

### (e2) Composite `ip + email`

- **Property:** *distinct honest users behind one address get independent budgets.*
- **Test must cause:** N+1 requests, same `x-forwarded-for`, **distinct** emails → all succeed; then
  N+1 with the **same** email → the last is refused.
- **Entailment gap:** this test passes for an implementation that provides **no adversarial bound at
  all**, since an attacker varies email freely. Passing it must never be recorded as "the register
  rate limit is enforced" — only as "honest users are not collectively throttled". **This is exactly
  the D-191 substitution to refuse.** It also silently widens the email-enumeration oracle; a second
  test should pin whatever bound is intended there, or the gap should be named.

### (f) Email verification

- **Property:** *an account cannot reach any authenticated surface until control of the mailbox is
  demonstrated.*
- **Test must cause:** register → attempt login and attempt to reach an org-scoped page → assert
  **refused**; follow the emailed token → assert **now permitted**. Plus: a **forged/replayed/expired**
  token → refused.
- **Entailment gap:** *"blocks login"* is **not** *"blocks access"* — this is the precise shape of the
  eight D-191 defects ("stop accepting answers" implemented as "block evidence uploads"). The test
  must assert against **the authenticated surface**, and against **every** entry point that could
  mint a session, not just the login form. Enumerate those from disk, and add the guard's production
  call sites to `__tests__/integration/trigger-enumeration.test.ts` (AGENTS.md §3).

### (g) Reduce suite registrations / test-only reset

- **Property:** *the suite's register traffic stays under the configured cap **as the suite grows**,
  and no reset path is reachable in production.*
- **Test must cause:** a check that **derives** the suite's register-call count from disk and
  compares it to `RATE_LIMITS['POST:/api/auth/register'].max` **generated, never hard-coded** (this
  is D-195's own O-10). Plus, if a reset path ships: a production-mode request to it asserting
  **404/403**, and a `preauth-surface`-style pin on its export.
- **Entailment gap:** a count derived by grepping for one string is one lens and will miss a
  registration driven a different way — e.g. it must catch **both** `request.post('/api/auth/register')`
  and form-driven `Create Account` clicks, **and** must not miscount the invitation form as this
  route (§1.2, which is precisely the error D-195 itself made).

---

## 8. `what-if-oracle` on the decomposition (AGENTS.md §3.5)

Run against *"what if the D-195 fix ships exactly as decomposed — (a), (b) or (c)?"*, with **Ψ** and
**∞** aimed at the whole design rather than a named variable. Only the branches that produced
something the rest of this document did not already contain are reported.

### Ψ Wild Card — the variable nobody is tracking: **organization-slug squatting**

Registration derives the org slug **server-side from the submitted name**
(`deriveSlug`, `lib/data/preauth.ts:411`), and D-101 deliberately made collisions **unreportable** —
"a form reporting *that slug is taken* is an existence oracle", so `createOrgInTx` retries silently
and, after five attempts, writes a random slug.

Consequence nobody has enumerated: **an attacker who mass-registers with real institution names
claims their slugs.** `Makerere University` → `makerere-university`. When the genuine institution
later registers, it collides, and by design it is **told nothing** — it silently receives
`makerere-university-a1b2`, an opaque URL, with no error, no explanation and no recourse surface in
the product. The security property that makes collisions safe (no existence oracle) is exactly what
makes squatting invisible to its victim.

This composes with D-112 (institutions whose names are not NFKD-foldable to Latin *already* land in
the opaque `org-xxxx` namespace) to produce a specifically nasty outcome for this product's stated
adopter population: **the institutions most likely to get an opaque URL by squatting are also the
ones most likely to get one by script-folding.**

Three reasons this belongs in front of the human partner rather than in a footnote:

1. It is **damage that persists after the attack stops.** Every other consequence of mass
   registration is cleanable — delete the rows. A squatted slug held by a soft-deleted org still
   occupies a `UNIQUE` constraint (`prisma/schema.prisma:280`; `deletedAt` does not free the slug).
2. It **inverts the direction of every option in §6.** Every ergonomics option raises the ceiling on
   how fast slugs can be claimed. It is the one consideration that argues *against* a generous cap,
   and it did not appear anywhere in the dispatch, the register row, or my own first pass.
3. It is **not addressed by (f) either** — an attacker willing to verify 200 mailboxes still squats
   200 slugs. Only a namespace policy addresses it (reserved names, claim/dispute process, or
   institution-verified slugs).

**Recommended: a new register row, regardless of which option is chosen.** Not for me to open — it is
outside this task's assigned scope (AGENTS.md §4: nothing written outside assigned scope) — so it is
raised here for the controller.

### ∞ Second Order — the cap acquires a new owner and never returns

First-order: raise the cap; the suite goes green; D-195 closes.

Second-order: D-195 specifies that O-10 must **generate** the expected registration count from
`lib/rate-limit.ts`. Combine that with a raised cap and the standing rule that a red required check
must be fixed, and the steady state is: *someone adds a registering test → the generated check goes
red → the cheapest green is to raise `max`.* Within a few iterations **the production security value
is being set by the size of the test suite, one increment at a time, with no security reasoning at
any step and no moment at which anyone notices the control changed hands.** Each increment is
individually reasonable; the sequence is not — the exact "locally correct, globally wrong" shape
AGENTS.md §3 documents.

This is a governance defect, not an arithmetic one, and it explains why **(d)** deserves weight
disproportionate to how minor it looks: separating the CI value from the production value is what
keeps a security number under a security owner. It also argues that whatever value is chosen should
be accompanied by a **comment in `lib/rate-limit.ts` stating what population the number serves and
what would justify changing it** — so the next person to raise it has to disagree with a reason
rather than edit a bare literal.

### Φ Contrarian

Reported in-place as option **(f)**: the consensus premise is "5 is the wrong number"; the contrarian
reading is that **the number is not the control**, and §3.2's empty table is the evidence.

### Δ Worst Case

Cap raised to 50, nothing else changed, D-195 closed as done. The platform now presents, at first
deployment, an unauthenticated endpoint that creates fully-live owner tenants at 50 per spoofable
bucket with no verification and no CAPTCHA — and the register records the matter as **resolved**. The
worst outcome here is not the number; it is **closing the row**, because closure is what stops anyone
looking again. Whatever is chosen, D-195's closure text must state, in its own words, that the
adversarial axis was **not** addressed and name the row that carries it.

---

## 9. What I did **not** verify

- **The CI log itself.** §1.1's "five refusals, not one" is derived from the call count, the
  `--list` order and the `firstRefusal` gate — all verified — but I did not re-run CI. Falsification
  test given inline.
- **Multi-instance behaviour.** No deployment exists (D-018). The per-process claim is read from
  `lib/rate-limit.ts:42`, not observed under load.
- **Real NAT.** The shared-address scenario was simulated with a constant `x-forwarded-for` header,
  which exercises the same code path but is not a real carrier-grade NAT.
- **Live browser UX of the 429.** I confirmed the status, `Retry-After: 884`, the JSON body, and by
  reading `app/(public)/register/page.tsx:30` that it reaches `setError`. I did **not** drive a
  browser to the register page and watch the message render. If the human partner wants the
  distinguishability finding (§4.2) at full C5 strength, that is a five-minute Playwright/DevTools
  check.
- **Cost of option (f).** Scoped by analogy to the existing invitation-token machinery (D-097) and
  the existing Resend transport. Not implemented, not spiked. Stated as an estimate, per §5's
  "effort claims are claims".
- **`engineering-skills:adversarial-reviewer` was not run on this document.** AGENTS.md §2's row on
  finishing a design artifact fires here, and self-review is recorded as 0-for-7 on this class. I am
  reporting the gap rather than laundering it: **the controller should run an adversarial pass
  briefed to attack this decomposition — "what is missing, and what lens would reveal it?" — before
  this reaches the human partner.** The §3 lens-variation I did run (search-root variation, which
  produced §2.4 and the three-axis relation in §6.1) is not a substitute for an independent reviewer.

---

## 10. One-paragraph summary for the decision

The control is a 5-per-15-minute cap keyed on a **client-supplied header**, live-confirmed to yield a
fresh budget per forged value (7/7 accepted with rotating `x-forwarded-for`; 500/500 at the unit
boundary), so it provides **no adversarial bound whatsoever** — while it is simultaneously the
**only** anti-abuse control on account creation, since the repo contains no email verification, no
CAPTCHA, no approval step and no quota, and one request yields a fully-live owner tenant costing the
server ~230 ms of bcrypt. Against honest shared-address users it binds hard and by *attempts* rather
than accounts: five tries per institution per 15 minutes, then a 429 whose message carries no
duration, no cause and no alternative, on the platform's own sign-up page. The e2e suite is already
**five registrations over budget**, not at zero headroom, and the test written to observe the limit
asserts nothing under refusal. The real option space runs on three axes — ergonomics ((a), (d), (e2),
(g)), adversarial ((e1), (f)), and governance ((d)) — and the dispatch's three options all sit on the
first; (b) in particular looks like an adversarial move but under a forgeable key hands an attacker a
platform-wide registration outage. Two findings nobody was tracking: raising the cap raises the rate
at which **organization slugs can be squatted**, silently and permanently, against exactly the
institutions this product targets; and pinning the e2e count to this literal quietly transfers
ownership of a security value to the test suite.
