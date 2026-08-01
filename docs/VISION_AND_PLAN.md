# MAK-AI Responsible AI Toolkit — Vision & Execution Plan

**Status:** Draft for review (v0.1) · Owner: engineering · Last updated: 2026-07-19

This document is the persistent source of truth for *where this product is going and how we build it*. It is deliberately requirements-driven: the current live product is the baseline we scale **from**, and prior implementation artifacts are references we evaluate on merit — not mandates.

---

## 1. Current state (the honest baseline)

The live product at `makrai.netlify.app` is a **static, client-rendered single-page app** (Vite + React, hosted on Netlify). It is:

- **Anonymous** — no accounts, no identity.
- **Single-browser** — progress lives in `localStorage`; nothing persists across devices or survives a cache clear.
- **Backend-free** — `connect-src 'self'`; no server, no database, no API.
- **A self-graded questionnaire** — the user answers questions about one AI system and receives a maturity score and a report.

Its genuine assets are three: a well-tested **assessment engine** (staged scoring, cross-stage weighting, evidence classification), **research-grounded content** (3 lifecycle stages × 21 risk areas × 28 controls × 8 principles, sourced from NIST SP 1270, the UNESCO Recommendation, EU AI Act, NIST AI RMF), and a mature **assessment/report UX**. These are the crown jewels and are portable.

*(A separate local Next.js rebuild exists as a single-tenant reference implementation. It is treated in this plan as a spike to evaluate and harvest in Phase 0 — not as the foundation.)*

---

## 2. Vision

**The platform becomes the *system of record for responsible-AI evidence*** — the place where RAI evidence accumulates across an institution's AI portfolio, and from which the governance artifacts teams actually need are generated. The assessment is the on-ramp; the durable value is the evidence, the trail, and — in aggregate across institutions — the benchmark and the research corpus.

This is a deliberate escape from the product's current category. A self-attestation score is precisely the "ethics washing / box-ticking" that this framework's own evidence base condemns (see area PO-03 *Accountability Gap*, PO-07 *Documentation Deficit*). Scaling a questionnaire to many institutions only scales the checkbox. The vision is defined by five shifts that give the tool teeth:

1. **From self-rating → evidence-linked claims.** Responses can carry evidence (artifacts, links). Each assessment has a **credibility tier**: `self-attested → evidenced → peer-reviewed → independently-verified`. This one mechanism is the structural answer to box-ticking.
2. **From a score → artifacts teams need.** The assessment already collects the inputs for a **model card, datasheet, risk register, and audit-ready RAI report** — generate them. The tool produces work the team would have had to do anyway. (This is the primary adoption driver — see §3.)
3. **From a quiz → the ML workflow.** An **API + CLI/CI gate** lets teams assess a model version from their pipeline. RAI shifts left, into where AI is actually built.
4. **From a snapshot → longitudinal + cross-institutional comparison.** Track a system across versions and time; benchmark against anonymized peers and sector baselines. This is why *cross-institutional* matters: the benchmark and percentile only exist because many tenants contribute normalized data — a real network effect.
5. **From advice → a closed remediation loop.** Gaps map to concrete controls and templates; remediation is tracked; re-assessment shows movement; credibility tier can *rise* as evidence is added.

In this framing the product is **RAI governance infrastructure**, not a questionnaire — and that is what is worth scaling cross-institutionally.

---

## 3. Product decisions (locked)

### 3.1 Primary adopter — team self-improvement
All three adopter classes matter (team self-improvement, institutional assurance, research corpus). When forced to rank, **team self-improvement is primary.** Consequence for sequencing: after the credible multi-user core, we lead with the features that *reduce a team's own workload* — artifact generation (model cards, datasheets) and workflow integration (API/CLI) — because those are what make a self-improving team return. Assurance (review/sign-off, verification tiers) and the research corpus are built, but sequenced behind that.

### 3.2 Standards alignment — ISO/IEC 42001 + an African/Global-South anchor (non-negotiable)

Assessment output must be mappable to the standards institutions are increasingly required to satisfy, and **at least one anchor must be tailored to the African / Global South context** — research-backed and justifiable.

- **International primary — ISO/IEC 42001:2023** (AI Management System). Organization-level "how you govern AI," the natural fit for a portfolio/assurance tool.
- **Global South anchor — the African Union Continental Artificial Intelligence Strategy (adopted July 2024, Accra).** Chosen on evidence, not availability:
  - It is the **authoritative continental instrument** — endorsed by the AU Executive Council for all 55 member states — and is explicitly *Africa-centric*: human-rights- and **Ubuntu-**rooted, development-focused, risk-based.
  - Decisively, its multi-tier governance approach **explicitly calls for the "development of AI assessment and evaluation tools" and African-led evaluation** — *this platform directly operationalizes a named action of the strategy*, rather than merely nodding to it.
  - It endorses **UNESCO's Ethical Impact Assessment (EIA)** as the impact-assessment method and rests on data-governance instruments — the **Malabo Convention** (2014, in force 2023) and the **AU Data Policy Framework** (2022) — which map cleanly onto the framework's privacy/consent area (PP-06).
- **Operational assessment methodology — UNESCO Ethical Impact Assessment (EIA) + Readiness Assessment Methodology (RAM).** UNESCO's Recommendation on the Ethics of AI (2021) already underpins the framework's 8 principles; its EIA/RAM are the Global-South-inclusive assessment methods the AU strategy points to, and RAM has been piloted across Southern Africa.

**Design consequence:** the framework's 21 areas / 28 controls become mappable, via a versioned crosswalk, to *both* ISO 42001 controls *and* the AU strategy / UNESCO EIA. Output can then read "audit-ready against ISO 42001" and "aligned to the AU Continental AI Strategy." (Note: sources differ on whether the AU strategy enumerates a fixed list of "15 principles" vs. 15 action points; the crosswalk will be built against the primary AU document, not a secondary summary.)

*Sources are listed in the appendix.*

---

## 4. Audit — gaps between the live SPA and the vision

### 4.1 Product / architecture gaps
- No identity, persistence, or multi-user (expected).
- **Credibility gap** — self-attestation only; nothing evidenced or verifiable. This is the core *utility* flaw, not a missing feature.
- **Framework is hardcoded, unversioned JSON.** Fatal for the vision: assessments can't be compared across framework revisions, and institutions can't customize context. The framework must become **versioned data**, each assessment pinned to a version.
- **The score is an opaque absolute** — no baseline, and no defensible basis for collapsing 21 areas into one percentage. (The framework's own IP-04, *metric-selection impossibility*, argues against false precision.) Move to **maturity levels per area/principle**, with the single number as a rollup, not the headline.
- **Assessment is disconnected from artifacts and workflow** — advice, not action.

### 4.2 Framework / domain improvements
- Add the **standards crosswalk** (§3.2) — the single largest utility jump for institutional users.
- Adopt a **defensible scoring methodology** (maturity model) before institutions base decisions on it.
- Version and govern the framework so it can evolve and be regionally contextualized without a code deploy.

### 4.3 Keep (harvest)
The assessment engine, the content, and the report/assessment components. Everything else (storage, identity, multi-tenancy, evidence, workflow) is net-new.

---

## 5. Target architecture (first principles)

- **Harvest:** engine, content, proven report/assessment UI components.
- **Design fresh:** the **multi-tenant data model** and identity/tenancy layer. Multi-tenancy is a *foundational* schema decision (isolation + RBAC), not a nullable-`orgId` afterthought — retrofitting it is how the IDOR class of bug is born. Core entities:

  `Organization → Member (roles: owner/admin/assessor/reviewer/viewer) → Project (AI system) → Assessment (versioned, time-series) → Response → Evidence (artifact) → RemediationItem → FrameworkVersion → BenchmarkAggregate (anonymized)`

- **Tenancy model:** shared database with rigorous org-scoping + row-level isolation. Security is foundational precisely because tenants share infrastructure.
- **Framework as versioned data:** question bank, areas, controls, principles, and the standards crosswalk become versioned records; assessments pin to a `FrameworkVersion`.
- **New infrastructure the vision requires:** object storage for evidence artifacts; background jobs (artifact generation, benchmark aggregation); an API surface for workflow integration.
- **The existing rebuild:** evaluated in Phase 0 as a reference; harvest parts that fit, redesign the tenancy/data layer. No pre-commitment either way.

---

## 6. Execution plan

**Every phase exits only when the app is driven end-to-end in a real browser** (Playwright / Chrome DevTools), not merely built. Risky integrations are proven in thin slices before breadth. No external deadlines drive this sequence.

### Phase 0 — Foundations & de-risking
- Architecture decisions: tenancy model, data model, framework-as-versioned-data, RBAC.
- Time-boxed **technical evaluation of the existing Next.js rebuild**; decide harvest-vs-redesign with evidence.
- **Live thin vertical slice:** one org, one user, one assessment persisted and scored end-to-end, verified in-browser (proves engine-in-server-context, tenant isolation, storage).
- *Exit:* architecture decision recorded; thin slice demonstrably works live.

### Phase 1 — Credible multi-user core
- Organizations, members, roles; projects; **persistent versioned assessments**; migrated engine + content + report; **evidence attachment + credibility tiers**.
- *Exit:* two orgs, isolated data, a full assessment with evidence, verified live; authz/IDOR tests green.

### Phase 2 — Utility depth *(leads on team self-improvement, per §3.1)*
- **Artifact generation** (model card, datasheet, risk register, audit report); remediation loop with re-assessment and score-over-time; review/sign-off workflow.
- *Exit:* a team can assess → attach evidence → generate a model card → remediate → re-assess and see movement, live.

### Phase 3 — Cross-institutional value
- Anonymized **benchmarking / percentiles**; the **research corpus** export; framework **customization + governance** (institutions extend, contribute back).
- *Exit:* benchmarking works across ≥3 seeded orgs without leaking tenant data (privacy verified).

### Phase 4 — Workflow integration & assurance
- **API + CLI/CI gate**; the **standards crosswalk** surfaced in output (ISO 42001 / AU strategy / UNESCO EIA); verification tiers.
- *Exit:* a model version can be assessed from a pipeline; output is audit-ready against the crosswalk.

---

## 7. Cross-cutting principles
- **Security is foundational**, not a phase — multi-tenant data isolation is verified continuously.
- **Live end-to-end verification is the bar** for "done," every phase.
- **Framework versioning and governance** from day one.
- **Honesty over completion** — unverified work is labeled unverified.

---

## 8. Open decisions / parking lot
- Hosting/deployment model — deferred; not a design input until raised.
- Which artifact to generate *first* in Phase 2 (model card vs. datasheet).
- Scoring methodology specifics (maturity-level rubric) — to be designed with the domain content in Phase 1.

---

## Appendix A — Standards & sources (research-backed)
- **African Union, Continental Artificial Intelligence Strategy** (July 2024, Accra) — au.int/sites/default/files/documents/44004-doc-EN-_Continental_AI_Strategy_July_2024.pdf
- **UNESCO Recommendation on the Ethics of Artificial Intelligence** (2021); **Ethical Impact Assessment (EIA)** and **Readiness Assessment Methodology (RAM)**.
- **ISO/IEC 42001:2023** — AI management systems.
- **Malabo Convention** (AU Convention on Cyber Security and Personal Data Protection, 2014; in force 2023); **AU Data Policy Framework** (2022).
- **NIST AI RMF 1.0**; **NIST SP 1270** (bias taxonomy, foundational to the 21 areas); **EU AI Act**.

## Appendix B — Skills
Skill usage for this project is governed by `SKILLS_INVENTORY.md` (which skills, mapped to these phases) and the standing operating rule in `CLAUDE.md` (consult before each task).
