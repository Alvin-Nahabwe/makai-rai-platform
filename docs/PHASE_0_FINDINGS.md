# Phase 0 — Live Verification Findings & Architecture Decision

**Status:** Complete · Date: 2026-07-31 · Method: the existing Next.js rebuild driven end-to-end against a live Postgres in a real (headless) browser.

This is the evidence Phase 0 exists to produce: an evidence-based **harvest-vs-redesign** decision, grounded in what the rebuild actually does when exercised — not in its prior status record.

---

## 1. What was verified working live (with DB proof)

Every step below was driven through the real UI and confirmed in Postgres:

- **Auth:** registration (name/email/password + required ToS consent + optional research consent) → user persisted; login; logout; re-login; role-based session.
- **Projects:** creation (after a fix — see B1), project detail page, assessment listing.
- **Full assessment engine (the crown jewel):** 3-stage gated pipeline (In/Post locked until Pre done); 22 questions across 2 modules; a **gate question** and a **checklist question**; **varied** answers (0–4); **debounced auto-save to Postgres** (`engineState`); module navigation; stage-completion modal (native `<dialog>`); **differentiated area scores** (10%–80% from varied input).
- **Report:** server-side `generateReportData`; overall + per-principle readiness (Transparency 9% CRITICAL → Reproducibility 100%); strength / attention / gap / not-assessed tiering across all 21 areas; evidence classification; controls. Renders correctly in dark mode.
- **PDF:** `/api/reports/[id]/pdf` → HTTP 200, valid `%PDF-`, sanitized filename. (Thin at ~3.4 KB — content depth to review.)
- **Quick Check (Track D):** 10 questions → completion → **correct score (75, matching the deterministic expectation)** → result view → persisted (`mode=quick, status=completed, overallScore=75`).
- **Theme toggle (Track B):** sets `data-theme` + persists `theme` to localStorage; **survives navigation and logout**.
- **Admin:** role-based access guard; user table (13 users, role/status/actions); **self-actions correctly hidden** (self-lockout protection); **role-change API works** (promote → ADMIN, via the previously-missing endpoint that was fixed — no 404); assessments + settings pages render.

**Verdict on the crown jewels:** the engine, the research-grounded content, the scoring, the report, and the PDF are genuinely strong and work correctly live. These are keepers.

---

## 2. Bug harvest (all live-confirmed)

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| B1 | 🔴 | **Project creation broken** — the committed security refactor let `name` leak into the nested `ProjectMetadata.create`; Prisma 500'd. A regression that shipped unverified. | **Fixed live** |
| B2 | 🔴 | Registration *requires* accepting ToS + Privacy, but **`/terms` and `/privacy` 404** — forcing consent to documents that don't exist. | Open |
| B3 | 🟠 | **`/forgot-password` 404**, linked from every login page (feature "done" in the design, never built). | Open |
| B4 | 🟠 | **Dark-mode: `.assessment-header` renders light-on-white** — poor contrast; the theming was incomplete. | Open |
| B5 | 🟡 | **Report "Maturity Levels" legend shows all four tiers as "(0–24%)"** — range labels broken (key mismatch); dots are correct. | Open |
| B6 | 🟡 | **Sidebar nav text low-contrast in dark mode** (faint labels). | Open |
| B7 | 🟡 | **Hydration mismatch** — the Track B no-flash theme script mutates `<html data-theme>` before hydration; needs `suppressHydrationWarning` on `<html>`. | Open |
| B8 | 🟡 | `middleware` file convention deprecated in Next 16 (wants `proxy`). | Open |
| B9 | ⚪ | PDF output is thin (~3.4 KB) — review report depth in the PDF. | Open |

The pattern matters more than any single item: **several features the prior work marked "done" were broken or missing when actually exercised** (project creation, password reset, legal pages, dark-mode completeness). This is the signature of code that was never rigorously live-verified — exactly the gap this phase closes.

---

## 3. Architecture decision — Evolve, don't restart

The evidence points to a clear middle path between "adopt the rebuild wholesale" and "rebuild from scratch":

**Harvest (keep, with the fixes above):**
- The assessment engine (scoring, cross-stage weights, gating, evidence classification).
- The content / framework data (21 areas, 28 controls, 8 principles, question bank — research-grounded, multi-domain).
- The report + PDF rendering and the assessment/report UI components.
- The auth pattern (NextAuth v5 + credentials) and the ownership-check discipline from the security work.

**Rebuild fresh (do not inherit):**
- **The data model and tenancy layer.** The rebuild is **single-tenant with only a nullable `orgId` as prep** — that is not a foundation for the cross-institutional target. Organizations, membership, RBAC, and tenant isolation must be designed in from the schema up (retrofitting is how the IDOR class of bug was born in the first place).

**Fix-forward:** the B-series bugs are absorbed into Phase 1, not patched piecemeal now.

**So:** the existing rebuild is a **strong reference implementation and component donor**, not the production base and not disposable. Phase 1 builds the multi-tenant foundation fresh and ports the crown jewels onto it.

---

## 4. Immediate follow-ups — DONE (commit `baf2239`)
All of B1–B8 are fixed and verified live (dark + light):
- B1 project creation, B2 `/terms` + `/privacy`, B3 `/forgot-password`, B4 assessment
  header, B5 maturity legend + overall-score colour (getLevel vocabulary unified),
  B6 sidebar background, B7 `suppressHydrationWarning`, B8 `middleware`→`proxy`.
- `/forgot-password` is an honest placeholder; real self-service reset is Phase 1 (auth rebuild).
- `/terms` + `/privacy` carry draft content pending institutional legal review.

Next: **Phase 1 — the multi-tenant foundation** (Organizations, membership, RBAC, tenant isolation),
onto which the harvested crown jewels are ported.

*Screenshots captured during the drive: login, assessment, report (in the session scratchpad).*
