# Phase 1 — Multi-Tenant Foundation & Onboarding: Design Spec

**Status:** For review · Date: 2026-08-02 · Supersedes: `docs/PHASE_1_FOUNDATION_DESIGN.superseded.md`
**Depends on:** `VISION_AND_PLAN.md`, `PHASE_0_FINDINGS.md`, `DEFERRED_REGISTER.md`
**Process:** derived through `superpowers:brainstorming`, with `what-if-oracle` at the tenancy
fork, `engineering-advanced-skills:database-designer` on the schema, and
`engineering-skills:senior-security` on isolation/RBAC.

The prior design document was rolled back because it was produced without the mandated
process. This spec **re-derives** the design rather than ratifying it. Where it reaches the
same conclusion, that is a result, not an inheritance. Where it differs — and it differs in
four material places — the reasoning is recorded below.

---

## 0. Scope

**In scope — the isolation spine and org lifecycle:**
Organization / Membership / Invitation; onboarding; active-org resolution; the tenant-scoped
data-access layer; Postgres RLS; and porting the existing `Project` / `ProjectMetadata` /
`Assessment` / `RemediationItem` onto a `NOT NULL orgId`.

**Explicitly out of scope** (each gets its own spec — see register):
evidence attachment + credibility tiers (D-001), review/sign-off workflow (D-002),
framework-as-versioned-data (D-003), benchmarking (D-010), the consent model (D-008).

**Rationale for this cut:** the isolation spine is the genuinely hard-to-reverse part — it
shapes every table, index and foreign key. Everything else is additive on top of a correct
`orgId` schema and is safer to design once real tenant data flows.

---

## 1. Decisions, and where they differ from the superseded design

| # | Decision | vs. superseded |
|---|---|---|
| 1 | **Shared DB, row-level `orgId`** (not schema- or DB-per-tenant) | Same conclusion, re-derived |
| 2 | **RLS ships in Phase 1, gated by a time-boxed spike with an abort criterion** | **Differs** — superseded bundled "shared-DB" and "RLS now" as one signed-off decision |
| 3 | **Active org is URL-scoped** (`/orgs/[slug]/…`) with a remembered default | **Differs** — superseded chose session-stored |
| 4 | **Multiple owners permitted; floor of one, never zero** | **Differs** — superseded said "exactly one required per org" |
| 5 | **Zero-org is unreachable by construction** | **New** — not addressed in superseded |
| 6 | Roles: `owner` / `admin` / `assessor` / `reviewer` / `viewer` | Same; `reviewer` ships inert (D-004) |

### 1.1 Why the tenancy decision was unbundled (the `what-if-oracle` output)

The oracle's load-bearing finding: **"shared DB with row-level `orgId`" and "Postgres RLS in
Phase 1" are two separate decisions that get treated as one.** The first is genuinely hard to
reverse — retrofitting it is exactly what produced this codebase's 2026-07 systemic IDOR. The
second is genuinely *additive*: given a correct `NOT NULL orgId` schema, RLS can be layered on
later without touching application logic.

Branch probabilities: Best 12% · **Likely 40%** (works, but the Prisma/RLS integration taxes
schedule) · Worst 15% (RLS decorative because the app connects as table owner → leak) · Wild
card 10% (procurement mandates physical separation) · **Contrarian 18%** (multi-tenancy
machinery is speculative while the pilot is single-institution) · Second-order 5%.

Every branch — including the contrarian one — wanted the same four things. Those became the
non-negotiables: `NOT NULL orgId`, a scoped data layer, composite same-org FKs, and
authorization tests from the first route.

**Ψ branch recorded as accepted risk (D-015):** shared-DB co-mingling is in tension with the
Malabo Convention / AU Data Policy Framework that this product itself cites as standards
anchors. The escape hatch (dedicated-instance tier) is designed on paper, not built.

### 1.2 Why active-org moved to the URL

The superseded design's own pre-mortem states the guard as *"Active org is explicit in every
request (never inferred)"* — then chooses "session-stored, switchable in the UI." A
session-stored `activeOrgId` **is** ambient state; the stated guard and the chosen mechanism
contradict each other. Two concrete failure modes in this stack: `session: { strategy: 'jwt' }`
means an `activeOrgId` claim goes stale on membership revocation, and session-scoped context is
shared across browser tabs, so switching org in one tab silently re-points the others.

---

## 2. Entities & schema

### 2.1 New tables

- **`Organization`** — `id`, `name`, `slug` (unique; the URL segment), timestamps, `deletedAt`
  (soft-delete for the "restore my workspace" case).
- **`Membership`** — `orgId`, `userId`, `role`, `status`. `@@unique([orgId, userId])`.
- **`Invitation`** — `orgId`, `email`, `role`, `tokenHash` (sha256 — the raw token exists only
  in the email), `expiresAt`, `status`, `invitedById`, `acceptedAt`.

`User` remains **global** (a person, not a tenant record). `User.role` stays a *platform*
role, distinct from org roles. `User.lastActiveOrgId` (nullable `String`, **no foreign key**)
holds the remembered default — a UI convenience, never an authorization input.

*Amended 2026-08-02:* this was originally specified as a nullable FK with
`onDelete: SetNull`. That was reconsidered during execution planning. `SetNull` fires only on
org *deletion*, whereas the dangling case that actually occurs is membership *revocation* —
the org still exists, the user is simply no longer a member. Fallback-to-first-membership is
therefore required regardless, so the FK removes no code path while adding a second named
`User`↔`Organization` relation that Prisma must disambiguate from `Membership`. Since the
value is never an authorization input, a stale pointer is a UI detail, not a security issue.

### 2.2 Ported tables

`orgId String` **NOT NULL** on `Project`, `ProjectMetadata`, `Assessment`, `RemediationItem`,
replacing today's nullable stub from `20260629133510_init`. `ConsentRecord` stays user-scoped:
consent is personal, not organisational.

### 2.3 Composite same-org foreign keys

Each parent gains `@@unique([orgId, id])`; children reference the pair:

| Child | Foreign key |
|---|---|
| `Assessment` | `(orgId, projectId) → Project(orgId, id)` |
| `ProjectMetadata` | `(orgId, projectId) → Project(orgId, id)` |
| `RemediationItem` | `(orgId, assessmentId) → Assessment(orgId, id)` |

A plain `projectId → Project(id)` FK is satisfied by *any* project, including another tenant's.
Referencing the pair makes cross-tenant linkage **structurally unrepresentable** — the write
fails at the constraint, regardless of application correctness or RLS configuration.

### 2.4 Indexes

`orgId` leads every composite index on tenant tables (`[orgId, createdAt]`, `[orgId, status]`,
`[orgId, projectId]`, …).

**Deliberate exception:** `Membership` carries `@@index([userId])`. It is the bridge table and
is queried both ways; "which orgs am I in" is inherently cross-org and runs on every session to
render the switcher and resolve the remembered default.

### 2.5 Invariants that cannot be declarative

Both require tests (§6.3):
1. **Zero-org unreachable** — registration creates `User` + `Organization` + `Membership(owner)`
   in one transaction, or joins via invitation in one transaction.
2. **Never zero owners** — the last owner cannot be demoted or removed. There is no ceiling;
   owners may promote other owners, so departure/lockout is recoverable *inside* the tenant
   without privileged cross-tenant intervention.

---

## 3. Isolation & RBAC

### 3.1 Three layers with uncorrelated failure modes

| Layer | Enforces | Fails by |
|---|---|---|
| Composite same-org FKs | Cross-tenant references impossible | *cannot fail at runtime — it is a constraint* |
| Scoped data layer (`orgDb`) | `orgId` injected; role enforced | **omission** (a route bypasses it) |
| Postgres RLS | Rows outside the active org invisible | **misconfiguration** (missing policy; owner-role connection) |

Defence-in-depth is only real when layers fail independently. Three variants of "remember to
check `orgId`" would be theatre.

### 3.2 The data-access layer

`orgDb(activeOrgId, membership)` is the only path to tenant data. Routes never import `prisma`
— enforced by an **ESLint rule banning `lib/db` imports outside `lib/data/`**, so the
discipline is mechanical. `lib/authz.ts` is **deleted**, not extended: its ownership premise
(`assessment.userId !== user.id`) is wrong under tenancy, where a colleague in the same org
legitimately reads a project they did not create.

Per-request order: parse `slug` → look up membership → **404 if absent** (not 403; do not leak
org existence to slug probing) → open transaction → `SET LOCAL app.current_org_id` → query.

### 3.3 RLS and the abort criterion

```sql
USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
```

The `NULLIF` is load-bearing: after a `SET LOCAL` transaction the GUC retains an empty string,
and a bare `''::uuid` cast **errors** (intermittent 500s) rather than failing closed. Recorded
as a hypothesis to re-verify, not an inherited conclusion.

Required alongside: a **non-owner app role** (migrations run as a different role) and
`FORCE ROW LEVEL SECURITY` on every tenant table. Without it the table owner bypasses RLS and
the policies are decorative.

**Spike abort criterion — 5 working days.** Must prove on `prisma@7.8.0` specifically:
(a) `$extends` wraps every operation including nested writes and `$transaction`;
(b) `SET LOCAL` survives the pooling in use; (c) `NULLIF` fail-closed behaviour. If any is
unproven at day 5, fall back to scoped-layer-only and open a dated follow-up row (D-005).

### 3.4 RBAC matrix

| Action | owner | admin | assessor | reviewer | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| `org:read`, `member:list` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `org:update` | ✓ | ✓ | | | |
| `org:delete` | ✓ | | | | |
| `member:invite`, `member:remove` | ✓ | ✓ | | | |
| `member:grant_owner` | ✓ | | | | |
| `project:read`, `assessment:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project:create`, `project:update` | ✓ | ✓ | ✓ | | |
| `project:delete` | ✓ | ✓ | | | |
| `assessment:create`/`:respond`/`:complete` | ✓ | ✓ | ✓ | | |
| `remediation:update` | ✓ | ✓ | ✓ | | |

Escalation guards: an admin **cannot** grant or revoke `owner`; the last owner cannot be
demoted. `reviewer` is currently identical to `viewer` (D-004).

**Role is never carried in the JWT.** Tokens are self-contained and unchecked against the DB
per request, so a token-borne permission bit keeps granting access after revocation. The token
carries identity; membership and role are read per request.

### 3.5 Deliberate cross-tenant paths — both narrowed

- **`/admin/assessments`** ([page.tsx:12](../../../app/%28authenticated%29/admin/assessments/page.tsx#L12)
  — `prisma.assessment.findMany({` with no `where`): cross-tenant listing **removed** in
  Phase 1 (D-006). "The vendor can read all your RAI evidence" is indefensible for an
  assurance tool. Platform admin retains account management, which needs no tenant content.
- **`/api/research/export`** ([route.ts:18](../../../app/api/research/export/route.ts#L18) —
  filters by `userId`, no org scope): **gated off** in Phase 1 (D-007) pending the org-level
  consent model (D-008). Consent is currently per-user while the design calls for org-level
  agreements with individual opt-out; running a single-tenant consent model across tenants is
  not acceptable.

---

## 4. Onboarding & active-org

### 4.1 Registration is one transaction

A two-step "register, then create your org" flow allows a real user to exist with zero
memberships between steps. So registration is atomic, and the **cold-registration form gains an
Organization name field**.

| Path | Form | One transaction creates |
|---|---|---|
| Cold (`/register`) | name, email, password, **org name**, ToS consent | `User` + `Organization` + `Membership(owner)` |
| Invited (`/invitations/[token]`) | name, password (email pre-filled, no org field) | `User` + `Membership(role)` + invitation accepted |

An already-authenticated user accepting an invite gets the `Membership` only.

### 4.2 Routes

```
/                              → redirect to /orgs/<remembered>/dashboard
/orgs/[slug]/dashboard | projects | projects/[id] | assessment/[id] | assessment/[id]/report
/orgs/[slug]/settings/members
/invitations/[token]           ← pre-membership by nature
/api/orgs/[slug]/...           ← API mirrors the page hierarchy
```

### 4.3 Where the membership check runs

The `proxy` layer (Next 16's replacement for `middleware` — closes D-027) typically runs on the
edge runtime, where Prisma cannot practically reach Postgres. Resolving authorization there
would push us toward trusting a JWT claim — reintroducing the staleness bypass §3.4 rejects.

**Split:** `proxy` does cheap session-presence checks and unauthenticated redirects; the
`/orgs/[slug]` server layout and **every API route independently** do membership+role
resolution against the database. Page-side lookups are memoised per request (`cache()`); API
routes never depend on a layout having run.

### 4.4 Invitations

`pending → accepted | expired | revoked`. Token from `crypto.randomBytes`, stored only as
sha256 `tokenHash`, single-use, expiring. The inviter's role caps the invitable role. An invite
to an existing email joins that account rather than duplicating it.

**Honest dependency:** `resend@6.16.0` and `RESEND_API_KEY` exist, but no email has ever been
sent live in this app (D-022, `/forgot-password` 404s). Invitations would be the second
consumer of an unproven mechanism. Phase 1 needs the email path verified live, or the
copy-link fallback (D-030).

### 4.5 Org switching

Switching is a **navigation** to `/orgs/<other-slug>/dashboard`, not a state mutation. That is
what makes tabs independent and eliminates the confused-deputy class. It writes
`lastActiveOrgId` as a side effect.

---

## 5. The gated port & migration

### 5.1 Migration

No production deployment exists (D-018), so no production data. Expand → backfill → constrain,
in one migration:

1. Create `organizations`, `memberships`, `invitations`.
2. Backfill **one organization per existing user**, that user as `owner`.
3. Set each existing row's `orgId` to its creator's new org.
4. `SET NOT NULL`; add `@@unique([orgId, id])`, composite same-org FKs, `orgId`-first indexes.
5. Drop the old nullable `orgId` indexes.

**Why one org per user, not a shared "Legacy" org:** today each user sees only their own
projects. Dropping all existing users into one org would let every one of them read every
other's assessments — because org membership, not ownership, becomes the visibility rule. When
the unit of visibility changes, a backfill is an **access-control change**, not a data move.

### 5.2 Harvest classifications (VISION §4.3 gate)

| Asset | Class | Row | Phase-1 disposition |
|---|---|---|---|
| Engine mechanics (staging, gating, cross-stage weights) | ADAPT | D-034 | Ports — needed to run an assessment live |
| Scoring methodology (weights, thresholds, the %) | RE-DERIVE | D-020, D-031 | Ships **provisionally** (§5.3) |
| Content JSON | ADAPT | D-003, D-032, D-033 | Ports as-is; becomes versioned data in Phase 1b |
| Report + PDF | ADAPT | D-035 | Ports; org context and evidence links follow |
| Quick Check (`QuickAssessment.js`) | RETIRE | D-012 | Not ported. `AssessmentMode.quick` enum value **kept** (existing rows carry it); flow unreachable |
| `lib/authz.ts` | RETIRE | — | Deleted |

### 5.3 The score ships marked provisional

Phase 1 needs a runnable assessment to satisfy its exit criterion, but D-031 records that the
78 question weights (0.05–0.20) and the uniform 75/50/25 principle thresholds have **no
recorded derivation** — no `source`, `citation`, or `rationale` field exists anywhere in the
content. Shipping the number unmarked would be the tool self-attesting about itself, which is
precisely the failure its own framework names (PO-07, IP-04).

Therefore: **the score renders with an explicit provisional marker in UI and PDF until D-020
and D-031 both close**, and Phase 1 output is not presented to an external institution as
authoritative (D-037).

---

## 6. Test strategy

### 6.1 Baseline

83 unit tests pass across 4 files — all engine/scoring behaviour. Three Playwright specs cover
input validation, unauthenticated redirects, security headers, rate limiting.

**The gap:** a grep of the e2e suite for `idor|ownership|another user|403|forbidden` returns
nothing. **The systemic IDOR fixed in July 2026 shipped with zero regression tests.** The
existing suite thoroughly tests what was never broken and does not test what was.

### 6.2 Four structural tests

| # | Test | Guards |
|---|---|---|
| T1 | **Forced-RLS enumeration** — query `pg_class` for every table with an `org_id` column; fail if `relrowsecurity` or `relforcerowsecurity` is false | Shipping a tenant table without a policy |
| T2 | **Fail-closed GUC** — with no `app.current_org_id` set, a tenant query returns 0 rows and does not throw | The `NULLIF` regression |
| T3 | **Bypass ban** — ESLint rule + test asserting nothing under `app/` imports `lib/db` | Routes calling Prisma directly |
| T4 | **Composite FK** — insert an assessment with another org's `projectId` → constraint violation | The DB guard silently being off |

T1 converts "we remembered" into "we cannot ship without it."

### 6.3 Behavioural tests

- **RBAC matrix as fixture** — `can(role, action)` is data; tests are generated over every
  (role × action) cell, so adding an action without deciding all five roles fails the build.
- **IDOR matrix** — every resource route × {other-org member, non-member, unauthenticated} → 404.
- **Invariants** — zero-org unreachable; last-owner protection; admin cannot grant `owner`.
- **Session staleness** — revoke a membership mid-session; the *next* request is denied.
- **Invitations** — single-use, expiry, role cap, existing-email join.

### 6.4 Live verification — the definition of done

Playwright against the real app: **two orgs, two users**; A cannot reach B's project by direct
URL; the switcher moves context; a full assessment runs end-to-end; isolation confirmed in
Postgres. Followed by a plain statement of what was and was not verified live.

---

## 7. Implementation order

1. **RLS + Prisma 7 spike** (5-day box; abort → D-005)
2. Schema + migration (§5.1)
3. RLS policies + restricted app role + `FORCE ROW LEVEL SECURITY`
4. `orgDb` scoped data layer + ESLint bypass ban
5. Auth/session rewrite (identity-only JWT; per-request membership)
6. Registration + invitations + email (closes D-021, D-022)
7. Active-org routing + `middleware`→`proxy` (closes D-027) + switcher
8. Port project/assessment/remediation routes onto `orgDb`
9. Port engine + report/PDF (classifications D-034, D-035 recorded first)
10. Live verification (§6.4)

Steps 1–4 are the spine; nothing else is safe to build until they hold.

---

## 8. Deferrals first recorded during this design process

Registered per AGENTS.md rule 6: **D-029** (slug immutable), **D-030** (copy-link invite
fallback), **D-034** (engine classification), **D-035** (report/PDF classification),
**D-037** (provisional-score marker removal), **D-038** (backfill is dev-only; no prod
migration rehearsal), **D-039** (engine tests validate behaviour, not weight provenance).

D-031 through D-036 were opened by the harvest-semantics work that preceded this spec
(commit `9e39878`) and are cited here because this spec's port gate depends on them.

Pre-existing rows this spec closes or fires: D-021, D-022, D-027 (in scope);
D-005, D-030 (conditional).

---

## 9. What this spec does not answer

- Whether the scoring methodology is defensible (D-020, D-031) — **the largest open risk in the
  product**, deliberately outside this spec's scope.
- Whether the framework content is current and complete against ISO 42001 / AU / UNESCO
  (D-032, D-033).
- Hosting, and therefore the real cost of the dedicated-instance escape hatch (D-018, D-015).
- Whether email delivery works at all (D-022) — assumed, unproven.
