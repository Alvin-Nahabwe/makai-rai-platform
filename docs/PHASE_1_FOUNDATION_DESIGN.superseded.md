# Phase 1 — Multi-Tenant Foundation Design

**Status:** Draft for sign-off (v0.1) · Date: 2026-07-31 · Depends on: `VISION_AND_PLAN.md`, `PHASE_0_FINDINGS.md`

This is the part Phase 0 decided to **build fresh**: the data model, tenancy, and RBAC that the harvested crown jewels (engine, content, report, PDF) bolt onto. It is the most hard-to-reverse decision in the project, so it is designed and signed off before any schema is written.

**Locked inputs:** primary adopter = team self-improvement; standards = ISO 42001 + AU Continental AI Strategy / UNESCO EIA; a user may belong to **multiple organizations**; roles = **owner / admin / assessor / reviewer / viewer**.

---

## 1. The tenancy decision (the one that determines everything)

**Options considered**

| Model | Isolation | Cross-tenant queries (benchmarking/research) | Ops cost | Fit |
|---|---|---|---|---|
| **A. Shared DB, row-level `orgId`** | App scoping + Postgres RLS | **Trivial** (single schema) | Low | ✅ |
| B. Schema-per-tenant | Strong (separate schema) | Painful (union across N schemas) | Medium | ✗ |
| C. Database-per-tenant | Strongest | Very painful | High | ✗ |

**Decision: A — shared database, row-level `orgId` scoping, with a mandatory tenant-scoped data-access layer and Postgres Row-Level Security (RLS) as defense-in-depth.**

The deciding factor is the vision itself: **cross-institutional benchmarking and the research corpus require querying *across* tenants** (percentiles, sector baselines). That is native in a shared DB and fights you in schema/DB-per-tenant. The isolation risk — the same IDOR class we already fought — is mitigated structurally (Section 5), not left to discipline.

### Pre-mortem (what-if-oracle) — how shared-DB isolation fails, and the guard

| Scenario | Failure | Guard |
|---|---|---|
| **Likely** | One query forgets its `orgId` scope → cross-tenant leak (the IDOR replay). | Tenant-scoped data layer (routes never call raw Prisma) **+ Postgres RLS** so a missed scope still can't read another org. |
| **Worst** | Benchmarking re-identifies a small org from aggregates. | **Minimum-cohort threshold** — never render a benchmark computed over fewer than *k* orgs/assessments. |
| **Contrarian** | A user in multiple orgs acts in the wrong org (confused deputy). | **Active org is explicit in every request** (never inferred); the data layer checks membership+role for *that* org. |
| **Second-order** | Deleting an org orphans or leaks its data. | `onDelete: Cascade` on every `orgId` FK; deletion is a tested path. |
| **Wild card** | RLS session variable not set on a pooled connection → policy uses a stale org. | Set `app.current_org_id` per request inside a transaction; fail closed (no org set = no rows). |

Net: the tenancy model is safe **because** isolation is enforced in two independent layers plus tests — not because application code is careful.

### 1b. Tenancy hardening (required — reviewed 2026-07-31)

Non-negotiable practices that make shared-DB safe and operable. All standard, no hacks.

- **Non-superuser app role + `FORCE ROW LEVEL SECURITY`.** Superusers, `BYPASSRLS` roles, *and the table owner* bypass RLS. Migrations/admin use one role; the app runtime connects as a restricted role; every tenant table gets `ALTER TABLE … FORCE ROW LEVEL SECURITY`. Without this, RLS is decorative.
- **`SET LOCAL` inside a transaction, never `SET`.** `SET LOCAL app.current_org_id` is transaction-scoped, so it is safe under PgBouncer transaction pooling and auto-resets — no leakage to the next borrower. RLS policy is **fail-closed**: unset variable matches nothing.
- **RLS does isolation only; the app does authorization.** Policy is a single indexed comparison `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. The **`NULLIF` is required** (proven by spike, 2026-07-31): after a `SET LOCAL` transaction the GUC retains an empty string, and a bare `''::uuid` cast *errors* (intermittent 500s) instead of failing closed — `NULLIF(...,'')` turns it into NULL → 0 rows, clean. Role/permission checks (`can(role, action)`) live in the app layer, never as JOINs in RLS policies — keeps RLS mathematically trivial and fast.
- **`orgId` leads every composite index** (`[orgId, createdAt]`, `[orgId, status]`, …).
- **Composite same-org foreign keys** (`(orgId, projectId) → Project(orgId, id)`) so the DB itself forbids cross-tenant references.
- **Noisy-neighbor controls:** read replica for analytics/reporting; precomputed benchmark aggregates (off the hot path); `statement_timeout`; separate pools for interactive vs. background work.
- **Restore without DB surgery:** soft-delete (`deletedAt`) + purge job for the "oops I deleted my workspace" case; scheduled per-org logical exports for targeted restore/portability; cluster PITR for disaster.
- **Enterprise escape hatch:** because all access goes through one tenant-scoped data layer and every row carries `orgId`, a **dedicated-instance tier** (separate DB/schema) can be offered later for clients mandating physical separation, without rewriting app logic.
- **Analytics/benchmark path deliberately bypasses per-org RLS** on a separate role/connection, guarded by the minimum-cohort threshold + anonymization — a controlled, explicit exception.
- **Primary guard is the scoped data-access layer** (fully under our control); RLS is defense-in-depth. **De-risk the Prisma+RLS integration first** (it needs a client extension wrapping each op in a transaction issuing `SET LOCAL`) before building breadth on it.

---

## 2. Identity & RBAC

A **User is a global person** (not org-scoped). Org membership is a separate relation, which is what makes multi-org work.

```
User (global: email, passwordHash, name, mustChangePassword, consent…)
  └─ Membership (userId, orgId, role, status)          ── a user has many
Organization (tenant: name, slug, settings)
  └─ Membership                                          ── an org has many
  └─ Invitation (orgId, email, role, token, expiresAt, status, invitedById)
```

- **Roles (per-org, on `Membership`):**
  - `owner` — full control, incl. delete org and manage admins. Exactly one required per org.
  - `admin` — manage members, projects, settings; cannot delete the org.
  - `assessor` — create/edit projects and assessments.
  - `reviewer` — review and sign off assessments (elevates credibility tier); **cannot edit responses**; read projects.
  - `viewer` — read-only.
- **Invites:** an `Invitation` lets you invite an email that may not have an account yet; accepting it (after registering/logging in) creates the `Membership`.
- **Active-org context:** because a user can belong to several orgs, every request resolves an **active org** explicitly (session-stored, switchable in the UI). Authorization = "does this user have a membership in the active org, and does its role permit this action?" A tiny `can(role, action)` policy table encodes the matrix.

---

## 3. Data model (tenant-scoped entities carry `orgId`)

```
Organization, Membership, Invitation                         (Section 2)

Project        (orgId, name, createdById, …) ─ ProjectMetadata (1:1)
Assessment     (orgId, projectId, createdById, version, mode,
                status, frameworkVersionId, engineState json,
                reportData json, overallScore, credibilityTier)
Evidence       (orgId, assessmentId, areaId/questionId, type,
                fileRef|url, tier, addedById, note)           ← NEW (vision)
RemediationItem(orgId, assessmentId, areaId, tier, status,
                evidenceLevel, completedById, notes)
Review         (orgId, assessmentId, reviewerId, decision,
                signedAt, notes)                              ← NEW (reviewer role)

ConsentRecord  (userId — personal, NOT org-scoped)
FrameworkVersion (global, shared — Section 4)
BenchmarkAggregate (anonymized, cross-org — Section 6)
```

Notes:
- `engineState`/`reportData` stay **JSON** (the harvested engine consumes them unchanged). Evidence/remediation are relational so they can be queried, reviewed, and rolled up.
- Every tenant table has `@@index([orgId])` and `orgId`-first composite indexes for the hot paths.

---

## 4. Framework as versioned data

The framework stops being hardcoded JSON and becomes **versioned records**, so assessments are comparable over time and can be governed without a redeploy.

- `FrameworkVersion` (id, label e.g. `2026.1`, status `draft|published|archived`, publishedAt, `content` json). `content` is a snapshot of the question bank + areas + controls + principles + **the ISO 42001 / AU / UNESCO standards crosswalk**.
- `Assessment.frameworkVersionId` **pins** each assessment to the version it was taken under (longitudinal comparability).
- **Start simple:** one global published `FrameworkVersion` seeded from today's content JSON; per-org customization and structured (table-based) editing come later. This keeps Phase 1 focused while making version-pinning real from day one.

---

## 5. Isolation & security enforcement (non-negotiable, built first)

Three independent layers, so no single mistake leaks tenant data:

1. **Tenant-scoped data-access layer.** Routes never call raw Prisma. They go through `orgDb(activeOrgId, membership)` which injects `orgId` into every query and enforces the role policy. This is the structural replacement for the ad-hoc ownership checks that failed before.
2. **Postgres Row-Level Security.** RLS policies on every tenant table keyed on a per-request session variable `app.current_org_id`. If app code ever forgets a scope, the database still returns nothing. Fail-closed: no org set → no rows.
3. **Authorization tests from day one.** Every resource route ships with an IDOR test (a member of org A cannot read/write org B's resource) and a role test (a viewer cannot mutate). These are the regression guard the earlier work lacked.

---

## 6. Cross-institutional value (built on the shared DB)

- `BenchmarkAggregate` — precomputed anonymized rollups (by sector, AI-system-type, framework version) refreshed by a background job. Reads enforce the **minimum-cohort threshold** from the pre-mortem.
- Research export (admin) reuses the existing consent-gated, anonymized export, now org-aware.

---

## 7. Migration / harvest path

- **Engine, report, PDF:** unchanged.
- **Content:** current `questionBank.json` / `assessmentAreas.json` / `scoringConfig.json` become the seed for `FrameworkVersion 2026.1`.
- **Auth:** `User` stays; add `Organization`/`Membership`/`Invitation`; session gains `activeOrgId` + resolved role; the forced-password-change and `isActive` logic carry over.
- **Existing data:** create a default org per current user (or one shared default) and backfill `orgId`. Minor, since this is effectively a fresh foundation.

---

## 8. For your sign-off
1. **Tenancy model = shared-DB row-level + RLS** (Section 1) — the load-bearing decision. Agree?
2. **Framework versioning starts as one global published version seeded from current content** (per-org customization deferred) — agree, or do you want per-org framework customization in Phase 1?
3. Everything else (roles, multi-org, evidence/credibility, review sign-off) follows the locked inputs.

On sign-off I implement in this order: schema + RLS + scoped data layer + authz tests (the isolation spine) → orgs/membership/invites + active-org UI → port projects/assessments/report onto the model → evidence + review sign-off.

---

## 9. Decisions from design review (2026-07-31)

1. **Tenancy = shared-DB row-level + RLS**, with the §1b hardening. Signed off.
2. **Framework versioning:** one global published version from current content; **per-org customization deferred**.
3. **Quick assessment: parked** — not ported to the new model; removed from the surface (code remains in git history). It is unevidenced self-scoring that runs counter to the evidence-first vision and adds a redundant flow. One assessment flow only.
4. **Knowledge Bank / Resources tab:** adopted as a planned feature (later phase). The `FrameworkVersion` content model treats controls / references / standards as first-class **now** so the tab renders clean data later.
5. **Research participation: always optional, never bundled into ToS** (coerced consent is indefensible for an RAI tool and violates informed-consent/data-protection norms). Raise opt-in ethically via reciprocal benefit (benchmarking tied to participation), **org-level research agreements with individual opt-out**, and transparency + easy deletion. Consent model is built in Phase 1.
6. **Research-data curation:** run a deliberate "what research questions do we want to answer, and what data curates that" pass (a short research-data-model note); capture stratification variables (sector, AI type, dataset, stage, geography, resources, regulatory context; consider foundation-model / in-house-vs-third-party and deployment-outcome-over-time). Collect **progressively** to avoid onboarding friction.
7. **Bug/issue reporting:** a small `Feedback` feature (form + admin view) added at **first real-user contact** (pilot), not Phase 1.
