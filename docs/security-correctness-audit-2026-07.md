# Security & Correctness Audit — MAK-AI RAI Toolkit Platform

**Date:** 2026-07-09
**Scope:** `toolkit-platform/` (Next.js 16 + Prisma 7 + NextAuth v5). Auth, authorization,
API routes, assessment engine, data model, core workflows. Complements the prior
UI/UX audit (`docs/ui-ux-audit.md`, `docs/audit-phase1-phase5-findings.md`), which
this does not repeat.
**Baseline:** 80/80 unit tests passing; `npm run lint` red (110 errors); prod build passing.

---

## Executive summary

The platform is architecturally sound and the assessment engine is well-built and
well-tested. But the authorization layer had a **systemic broken-object-level-access
(IDOR) flaw**: every resource route and two server pages authenticated the caller
but never checked that the resource *belonged* to them. Any logged-in assessor could
read, modify, complete, or **delete** any other user's projects, assessments,
remediation items, and PDF reports by guessing/knowing a UUID. Two core workflows were
also broken (the report link 404'd; admin user-management POSTed to a route that didn't
exist). All of these are now fixed and verified.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 3 | ✅ Fixed |
| High | 2 | ✅ Fixed |
| Medium | 4 | ✅ Fixed (3) / Documented (1) |
| Low / tech-debt | 5 | Documented; 1 fixed |

---

## Critical

### C1 — Broken object-level authorization (IDOR), systemic
**Files:** all of `app/api/assessments/**`, `app/api/projects/[id]`, `app/api/reports/[id]/pdf`,
plus server pages `projects/[id]/page.tsx` and `projects/[id]/compare/page.tsx`.

Every route checked `session?.user` (authentication) but not ownership (authorization).
Concretely, before the fix any authenticated user could:
- `GET/PUT /api/assessments/{id}` — read or overwrite **anyone's** assessment (incl. engineState).
- `POST /api/assessments/{id}/complete` — finalize and score anyone's assessment.
- `GET/POST/PATCH /api/assessments/{id}/remediation` — read/mutate anyone's remediation items.
- `GET /api/reports/{id}/pdf` — download anyone's report PDF.
- `GET/PUT/DELETE /api/projects/{id}` — view, edit, or **delete** anyone's project.
- `POST /api/assessments` — start an assessment on a project they don't own.
- Visit `/projects/{id}` and `/projects/{id}/compare` for any project.

**Fix:** Added `lib/authz.ts` — `getSessionUser()`, `authorizeAssessment()`,
`authorizeProject()` — that load a resource only if the caller owns it or is an admin,
returning `null` (→ 404, so existence isn't leaked) otherwise. Applied to every route
and both server pages. The PATCH remediation handler additionally verifies the target
item belongs to the authorized assessment.

### C2 — Report navigation 404 (core workflow broken)
**File:** `app/(authenticated)/assessment/[id]/page.tsx`

"View Report" / "Generate Report" pushed `/report/{id}`, but the route lives at
`/assessment/{id}/report`. Every user completing an assessment hit a 404. The prior
runtime-verification pass missed it because it only tested an *incomplete* assessment.
**Fix:** Corrected both navigation calls to `/assessment/{id}/report`.

### C3 — Admin user management POSTs to a nonexistent route
**File:** `app/(authenticated)/admin/users/page.tsx` → `/api/admin/users/[id]/role`

Promote / Demote / Deactivate were `<form>` POSTs to `/api/admin/users/[id]/role`,
which never existed → 404 on every click. The entire admin user-management feature
was non-functional.
**Fix:** Created `app/api/admin/users/[id]/role/route.ts` (admin-guarded, same-origin
CSRF check, self-lockout protection, security logging). "Deactivate" needed real data
support, so added `User.isActive` (schema + migration `20260709000000_add_user_is_active`),
enforced it in `lib/auth.ts` (deactivated accounts can't sign in), and made the UI show
Active/Deactivated status with a Deactivate/Reactivate toggle. Self-actions are hidden.

---

## High

### H1 — `complete` route trusted the client and had no guards
**File:** `app/api/assessments/[id]/complete/route.ts`

The route recomputed the score from stored engineState (good) but had no ownership
check, no idempotency (could re-complete and overwrite `completedAt`), and no guard
requiring at least one completed stage.
**Fix:** Ownership via `authorizeAssessment`; returns the existing record if already
completed (idempotent); rejects with 400 if `canGenerateReport()` is false; logs
`ASSESSMENT_COMPLETED`.

### H2 — `PUT /api/assessments/[id]` accepted arbitrary state, could edit completed work
**File:** `app/api/assessments/[id]/route.ts`

Any object was accepted as `engineState`, and a completed assessment could be silently
mutated (making its cached report drift from its state).
**Fix:** Rejects payloads without a `stages` object (400); rejects edits to completed
assessments (409). Ownership enforced.

---

## Medium

### M1 — Project name/description unvalidated → header-injection vector *(fixed)*
`POST /api/projects` used `name` raw. It flows into the PDF `Content-Disposition`
filename, so a name with CR/LF could inject headers, and length was unbounded.
**Fix:** `validateString` on name (≤200) and description (≤2000); PDF filename now
restricted to `[a-zA-Z0-9-_]` and truncated.

### M2 — Session typing relied on `as any` everywhere *(fixed)*
No NextAuth type augmentation existed, so `(session.user as any).id/.role` was scattered
across the codebase (a large share of the 110 lint errors) and defeated type safety on
the security-critical role check.
**Fix:** Added `types/next-auth.d.ts` typing `session.user.id` and `.role`; the auth
callbacks, guards, and all touched routes are now `any`-free. Lint errors dropped 110→91.

### M3 — Redundant/dead focus-trap code *(fixed)*
`assessment/[id]/page.tsx` had a manual focus-trap `useEffect` that queried
`[role="dialog"]` — which never matches the native `<dialog>` the modals now use, so it
was dead code duplicating behavior the browser already provides.
**Fix:** Removed; native `<dialog>.showModal()` handles focus and Escape.

### M4 — In-memory rate limiter won't hold across instances *(documented)*
`lib/rate-limit.ts` and account-lockout counters are per-process. Correct for the
single-instance classroom deployment, but horizontal scaling silently multiplies limits.
**Recommendation:** move to Redis (or the DB) before scaling out. Left as-is for now.

---

## Low / tech-debt (documented, not blocking)

- **L1 — "Quick" assessment mode is an orphan feature.** `AssessmentMode.quick`,
  `lib/engine/QuickAssessment.js`, and the "Quick" badges exist, but no UI path ever
  starts a quick assessment (`StartAssessmentButton` always creates `full`).
  Either wire it up or remove the dead code + enum.
- **L2 — Lint gate is red (91 errors).** Almost entirely `no-explicit-any` and
  `ban-ts-comment` in untouched UI components. `npm run verify` fails at the lint step,
  so CI can't gate on it. Recommend a mechanical `any`-removal pass across
  `components/**` and `app/**` pages, then flip lint to blocking.
- **L3 — Design-token debt.** 100+ hardcoded hex colors / magic numbers (see prior
  UI/UX audit). Blocks dark mode and consistent theming.
- **L4 — Default admin credentials.** `prisma/seed.ts` seeds `admin@air.ug` /
  `change-me-on-first-login`. Fine as a documented default, but there's no forced
  password change on first login — worth adding.
- **L5 — README is create-next-app boilerplate.** No project-specific setup/run/deploy
  docs at the app root (runbooks exist under `docs/runbooks/`).

---

## What was verified after the fixes
- `npx tsc --noEmit` — clean.
- `npm test` — 80/80 passing (unchanged).
- `npm run build` — passes; new admin route compiled; all routes build.
- `npm run lint` — 91 errors (down from 110); **no new** errors introduced by this work.

## Migration note
`prisma/migrations/20260709000000_add_user_is_active/` must be applied
(`npx prisma migrate deploy`) before the deactivate feature works in a live DB. The
Prisma client has already been regenerated locally.
