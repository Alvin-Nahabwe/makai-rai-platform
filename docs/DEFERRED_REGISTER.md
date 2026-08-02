# Deferred & Parked Register — MAK-AI RAI Toolkit

**Status:** Living document · Opened 2026-08-02 · Governed by `AGENTS.md` rule 6

The single audit trail for everything consciously *not* done yet. A decision to defer is a
legitimate engineering choice; losing track of it is not. This register exists so that no
deferral can be quietly dropped, forgotten, or papered over.

## Rules

1. **Nothing is ever deleted.** Rows are closed, not removed. History is the point.
2. **Every row needs a pick-up condition** — a date, an event trigger, or both. "Later" is
   not a pick-up condition.
3. **Closure requires evidence.** Per `AGENTS.md` rule 2, done means driven live. A closed
   row cites the commit and states what was verified live — and what was not.
4. **Dropping or changing a deferral is itself a recorded decision**, with justification.
   Moving something to `Dropped` without a written reason is not permitted.
5. **New deferrals enter in the same commit as the spec or change that created them.**

## Kinds

| Kind | Meaning | Closes when |
|---|---|---|
| `DEFERRAL` | Will be built, just not now | Built + verified live |
| `PARKED` | May or may not ever be done; decision itself is deferred | Decided either way, with rationale |
| `RISK` | Consciously accepted, not being mitigated now | Mitigated, or the risk materially changes |
| `BUG` | Known defect, not yet fixed | Fixed + verified live |

## Status values

`Open` · `Scheduled` · `In progress` · `Closed-done` · `Closed-dropped` · `Closed-changed`

---

## Register

| ID | Item | Kind | Opened | Why deferred | Pick-up trigger | Target | Status |
|---|---|---|---|---|---|---|---|
| D-001 | Evidence attachment + credibility tiers | DEFERRAL | 2026-08-01 | Own design surface; would dilute the Phase-1 isolation spine spec | Phase-1 spine merged + verified live | Phase 1b (own spec) | Open |
| D-002 | Review / sign-off workflow (`reviewer` role powers) | DEFERRAL | 2026-08-01 | Depends on D-001 credibility tiers | D-001 closed | Phase 2 | Open |
| D-003 | Framework as versioned data (`FrameworkVersion`, `Assessment.frameworkVersionId`) | DEFERRAL | 2026-08-01 | Own design surface (content shape, crosswalk, publish lifecycle) | Before the first real pilot assessment is created | Phase 1b | Open |
| D-004 | `reviewer` role ships inert (capabilities identical to `viewer`) | DEFERRAL | 2026-08-02 | Its distinguishing power belongs to D-002; inventing capabilities now would be speculative | D-002 picked up | Phase 2 | Open |
| D-005 | Postgres RLS fallback if the de-risking spike aborts | RISK | 2026-08-02 | Spike ran (`docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`): NO-GO. `PrismaClient.$extends({ $allModels.$allOperations })` wrapping ops in `base.$transaction(async tx => {...; return query(args)})` does not propagate the `set_config` GUC into `query(args)` — PROBE A returned 0 rows instead of 1 (fails closed, not open; confirmed stable under concurrency). Tasks 3 and 4 dropped as specified; proceeding with the scoped data layer as the sole runtime guard | Redesign of Task 3's data-layer scoping mechanism, informed by the spike's PROBE D lead (direct `tx.<model>.<op>()` calls on a manually-opened interactive transaction do correctly see the GUC) | Phase 1b — before RLS-dependent tasks resume | Scheduled |
| D-006 | `/admin/assessments` cross-tenant listing removed | PARKED | 2026-08-02 | Existed only because the app was single-tenant; "vendor reads all your RAI evidence" is indefensible for an assurance tool | A concrete platform-support need arises that cannot be met otherwise | — | Open |
| D-007 | `/api/research/export` gated off | DEFERRAL | 2026-08-02 | Consent is per-user today; org-level research agreements + individual opt-out (D-008) not yet designed | D-008 closed | Phase 3 | Open |
| D-008 | Consent model: org-level research agreements with individual opt-out | DEFERRAL | 2026-07-31 | Ethics-bearing design; must not be bundled into ToS (coerced consent indefensible for an RAI tool) | Before any cross-institutional research use | Phase 3 | Open |
| D-009 | Research-data curation pass (what questions, what stratification variables) | DEFERRAL | 2026-07-31 | Needs a deliberate research-data-model note; collect progressively to avoid onboarding friction | Alongside D-008 | Phase 3 | Open |
| D-010 | Benchmarking / `BenchmarkAggregate` + minimum-cohort (k) threshold | DEFERRAL | 2026-08-02 | Requires ≥3 tenants to be meaningful; k-threshold must exist before the first aggregate query ships | First aggregate/benchmark query is written | Phase 3 | Open |
| D-011 | Per-org framework customization | PARKED | 2026-07-31 | Phase 1 uses one global published version; customization is a governance surface of its own | Institution requests contextualization | Phase 3+ | Open |
| D-012 | Quick Check assessment mode parked/removed | PARKED | 2026-07-31 | Unevidenced self-scoring runs counter to the evidence-first vision; redundant second flow. Code remains in git history | Evidence emerges that a short on-ramp drives adoption | — | Open |
| D-013 | Knowledge Bank / Resources tab | DEFERRAL | 2026-07-31 | Planned feature; `FrameworkVersion` content model treats controls/references/standards as first-class now so it renders clean later | D-003 closed | Phase 2+ | Open |
| D-014 | Feedback / bug-reporting feature (form + admin view) | DEFERRAL | 2026-07-31 | Not needed before real users exist | First real-user contact (pilot) | Pilot | Open |
| D-015 | Dedicated-instance tier (escape hatch for physical separation) | RISK | 2026-08-02 | Designed on paper only; shared-DB co-mingling is in tension with the Malabo Convention framing the product itself cites | Any procurement/residency question from a ministry or funder | — | Open |
| D-016 | Soft-delete purge job for `Organization.deletedAt` | DEFERRAL | 2026-08-02 | Soft-delete lands in Phase 1; the purge/retention job is separable | Before production data retention matters | Phase 2 | Open |
| D-017 | Noisy-neighbour controls (read replica, `statement_timeout`, split pools) | DEFERRAL | 2026-08-02 | Premature before real multi-tenant load | Second active tenant, or first slow-query incident | Phase 3 | Open |
| D-018 | Hosting / deployment model | PARKED | 2026-07-19 | Deliberately not a design input until raised; also gates the cloud-provider skills tier | Raised by the user, or first deploy need | — | Open |
| D-019 | Which artifact to generate first (model card vs datasheet) | PARKED | 2026-07-19 | Sequencing decision for Phase 2 | Phase 2 start | Phase 2 | Open |
| D-020 | Scoring methodology (maturity-level rubric replacing the opaque percentage) | PARKED | 2026-07-19 | Needs domain content work; an irreversible fork requiring `what-if-oracle` | Phase 2 start, or first institutional decision based on a score | Phase 2 | Open |
| D-021 | B2 — `/terms` and `/privacy` 404 while registration *requires* accepting them | BUG | 2026-07-31 | Phase-0 harvest; absorbed into Phase 1 rather than patched piecemeal | Phase 1 onboarding work (registration is being rewritten) | Phase 1 | Open |
| D-022 | B3 — `/forgot-password` 404, linked from every login page | BUG | 2026-07-31 | Phase-0 harvest; email path (`resend`) present but unproven | Phase 1 auth work | Phase 1 | Open |
| D-023 | B4 — dark-mode `.assessment-header` renders light-on-white | BUG | 2026-07-31 | Cosmetic; batched with UI work | Phase 1 UI pass | Phase 1 | Open |
| D-024 | B5 — report "Maturity Levels" legend shows all four tiers as (0–24%) | BUG | 2026-07-31 | Cosmetic key mismatch; dots are correct | Phase 1 report port | Phase 1 | Open |
| D-025 | B6 — sidebar nav text low-contrast in dark mode | BUG | 2026-07-31 | Cosmetic; batched with UI work | Phase 1 UI pass | Phase 1 | Open |
| D-026 | B7 — hydration mismatch from the no-flash theme script | BUG | 2026-07-31 | Needs `suppressHydrationWarning` on `<html>` | Phase 1 shell rewrite | Phase 1 | Open |
| D-027 | B8 — `middleware` file convention deprecated in Next 16 (wants `proxy`) | BUG | 2026-07-31 | Touches the request pipeline that active-org resolution will rewrite anyway | Phase 1 active-org routing work | Phase 1 | Open |
| D-028 | B9 — PDF output thin (~3.4 KB); report depth in PDF unreviewed | BUG | 2026-07-31 | Content-depth question, not a crash | Phase 1 report/PDF port | Phase 1 | Open |
| D-029 | Org `slug` immutable in Phase 1 (no rename) | PARKED | 2026-08-02 | Renaming breaks every shared link and bookmark; doing it properly needs old-slug redirect records | An org asks to rename | Phase 2 | Open |
| D-030 | Copy-link invite fallback if email delivery fails live | RISK | 2026-08-02 | `resend` is installed but no email has ever been sent live in this app (see D-022); invitations would be its second unproven consumer | Email path fails live verification during Phase 1 | Phase 1, conditional | Open |
| D-031 | **Weight & threshold provenance** — 78 question weights (0.05–0.20) and uniform 75/50/25 principle thresholds have *no* recorded derivation | RISK | 2026-08-02 | Discovered 2026-08-02: the union of all question keys contains no `source`/`citation`/`rationale` field, and `questionBank.meta` holds only version/count/minutes. The numeric layer driving every score is untraceable — the tool's own PO-07 / IP-04 failure | Before any score is shown to an external institution; blocks D-020 | Phase 2 | Open |
| D-032 | Content currency audit vs NIST SP 1270 / UNESCO / EU AI Act | DEFERRAL | 2026-08-02 | Framework structure is plausibly research-grounded but has never been re-verified; the EU AI Act has moved since inception | Runs with D-003 (content becomes versioned data) | Phase 1b | Open |
| D-033 | ISO 42001 / AU Continental Strategy / UNESCO EIA crosswalk absent from content | DEFERRAL | 2026-08-02 | No crosswalk field exists anywhere in the content files, yet §3.2 promises output "audit-ready against ISO 42001". Not a bug — a missing dimension | Runs with D-003; required before the Phase 4 crosswalk claim | Phase 1b | Open |
| D-034 | Harvest classification of engine mechanics (staging, gating, cross-stage propagation) | DEFERRAL | 2026-08-02 | Proposed ADAPT: machinery is behaviourally proven but must serve versioned frameworks and org context | Before the engine ports (Section 4 gate) | Phase 1 | Open |
| D-035 | Harvest classification of report + PDF | DEFERRAL | 2026-08-02 | Proposed ADAPT: built to report one anonymous assessment; must carry org context, evidence links, credibility tier, longitudinal comparison | Before the report ports (Section 4 gate) | Phase 1 | Open |
| D-036 | Harvest-vs-redesign decision was made without the mandated `what-if-oracle` | RISK | 2026-08-02 | `SKILLS_INVENTORY.md` names it an irreversible fork requiring the oracle; `PHASE_0_FINDINGS.md` §3 shows no oracle run. Accepted for now because the classification gate (VISION §4.3) delivers the substantive value the oracle would have | Re-run if the classification work suggests the evolve-don't-restart call was wrong | — | Open |
| D-037 | Score renders with a **provisional** marker in UI + PDF; Phase-1 output not presented to any external institution as authoritative | RISK | 2026-08-02 | Phase 1 needs a runnable assessment for its live-verification exit criterion, but the scoring's derivation does not exist (D-031) and the methodology is scheduled for re-derivation (D-020). Marking it is the honest middle path between blocking Phase 1 and shipping an untraceable number unmarked | D-020 **and** D-031 both closed → remove the marker | Phase 2 | Open |
| D-038 | Migration backfill is dev-only; no production-data migration has been rehearsed | RISK | 2026-08-02 | No production deployment exists (D-018), so the expand→backfill→constrain path is exercised against dev data only | First real deployment | Phase 2 | Open |
| D-039 | Engine unit tests validate behaviour against themselves, not weight provenance | RISK | 2026-08-02 | 83 passing tests are real evidence the engine does what it was built to do, and no evidence that what it was built to do is correct. Keeping those claims separate is the point of the harvest gate | Closes with D-031 | Phase 2 | Open |

---

## Closure log

Closed rows keep their register entry above (status updated) and gain an entry here with
evidence. Nothing is deleted.

*(empty — no rows closed yet)*

---

## Review cadence

- **Every phase exit:** full register review. No phase exits with an `Open` row whose target
  is that phase, unless the row is explicitly re-targeted with justification.
- **Every spec written under `superpowers:brainstorming`:** its Deferrals section lands here
  in the same commit.
- **Every `what-if-oracle` run:** its decision triggers become rows if they imply deferred work.
