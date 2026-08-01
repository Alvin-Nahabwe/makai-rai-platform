# Skills Inventory — MAK-AI RAI Toolkit

**Status:** Draft for review (v0.1) · Companion to `VISION_AND_PLAN.md`

Purpose: pre-scope the skills worth consulting during this project so execution deliberately draws on them. This is **living** — skills are added/dropped as we go, and availability is verified at the point of use (the visible skill pool shifts between sessions as plugins/MCP servers connect).

Triage method: deep-scoped the plausibly-relevant skills; dismissed the rest by category with a one-line reason rather than reading every skill body. Two tiers below — **always-on** (fire on most substantive tasks) and **workstream-mapped** (consult when working in that area). The standing "consult before each task" rule lives in `CLAUDE.md`.

---

## Tier 1 — Always-on (consult on essentially every substantive task)

| Skill | When it fires |
|---|---|
| `rigor-loop` | Any analysis, decision, trade-off, or work you'll act on. (Active now.) |
| `superpowers:brainstorming` | Before any feature/component/behavior work — explore intent before building. |
| `superpowers:writing-plans` → `executing-plans` | Turn a spec into a staged plan, then execute against it. |
| `superpowers:test-driven-development` | Engine, scoring, API, and authz logic — test first. |
| `superpowers:systematic-debugging` | Anything broken or behaving unexpectedly. |
| `superpowers:verification-before-completion` + `verify` + `run` | Before calling anything "done" — drive it live (our stated bar). |
| `code-review` + `code-simplifier` / `simplify` | After each meaningful code chunk. |
| `security-review` | Every backend change touching auth, tenancy, or data access (multi-tenant = high stakes). |

## Tier 2 — Workstream-mapped (by plan phase)

**Architecture & data model (Phase 0–1)**
- `engineering-skills:senior-architect` — tenancy model, client/server boundaries, ADRs.
- `database-designer` / `database-schema-designer`, `database-design:postgresql`, `sql-pro` — multi-tenant schema, indexes, row-level isolation, JSONB strategy.
- `backend-development:architecture-patterns`, `migration-architect` — SPA→platform migration, framework-as-versioned-data.
- `tech-stack-evaluator` — evaluate the existing rebuild (harvest vs redesign).
- `engineering-advanced-skills:codebase-onboarding`, `monorepo-navigator` — map the rebuild during Phase 0 evaluation.

**Backend & API (Phase 1, 4)**
- `engineering-skills:senior-backend`, `backend-development:api-design-principles`, `engineering-advanced-skills:api-design-reviewer` — API surface for workflow integration.
- `engineering-advanced-skills:api-test-suite-builder`, `postman:generate-spec` / `postman:test` / `postman:security` — API contracts, tests, OWASP-API audit.

**Security (cross-cutting, foundational)**
- `engineering-skills:senior-security`, `senior-secops`, `security-pen-testing`, `red-team`, `threat-detection` — authz/IDOR, tenant isolation, pen testing.
- `engineering-skills:ai-security` — if/when the platform itself uses models (e.g., artifact drafting).
- `engineering-advanced-skills:dependency-auditor`, `env-secrets-manager` / `secrets-vault-manager` — supply chain, secrets.

**Frontend & UI (Phase 1–2)**
- `frontend-design`, `engineering-skills:senior-frontend` — the authenticated shell, dashboards.
- `ui-design:create-component`, `design-system-setup`, `design-review`, `responsive-design`, `interaction-design`, `visual-design-foundations` — component library, design tokens (a token system already exists to build on).

**Accessibility (cross-cutting)**
- `ui-design:accessibility-audit` / `accessibility-expert` / `accessibility-compliance`, `chrome-devtools-mcp:a11y-debugging` — WCAG on assessment/report flows.

**Live verification (every phase — our "done" bar)**
- `chrome-devtools-mcp:chrome-devtools` (+ `troubleshooting`, `debug-optimize-lcp`, `memory-leak-debugging`), Playwright MCP tools — drive the real app, capture console/network/screenshots.

**Decision support (Phase 0 & any irreversible fork)**
- `what-if-oracle` — pre-mortem / scenario analysis *before committing* a hard-to-reverse decision (harvest-vs-redesign the rebuild, tenancy model, scoring methodology). Complements `rigor-loop` (which checks the framing/verification *now*); this checks how the decision plays out across uncertain futures. Proven on this codebase — it previously surfaced the shared-NAT rate-limiting flaw. Situational, not routine.

**Artifact generation feature (Phase 2 — the primary-adopter payoff)**
- `docx`, `xlsx`, `pdf`, `pptx` — generate model cards, datasheets, risk registers, audit reports.
- `markdown-mermaid-writing`, `scientific-schematics` — diagrams/lineage inside reports.
- `dataviz` — dashboards, benchmarking charts, score-over-time (Phase 2–3).

**Content & copy quality (framework content revision + Phase 2 artifact prose)**
- `humanizer` — polish user-facing prose (question/area/control text, help text) and generated-artifact narrative so it reads professionally and human. Narrow scope: **user-facing copy and generated-document prose only — never code or internal docs.** Credibility matters for an RAI tool; AI-tell-laden copy undermines it.

**Research grounding (Phase 0, 2, 4 — standards crosswalk & framework upkeep)**
- `research-lookup`, `literature-search-openalex` / `-arxiv` / `-europepmc`, `citation-management` — verify/extend the standards mapping (ISO 42001, AU strategy, UNESCO EIA) and keep controls research-grounded.

**CI/CD, release & ops (Phase 0, 4)**
- `engineering-advanced-skills:ci-cd-pipeline-builder`, `release-manager`, `changelog-generator`, `observability-designer`, `runbook-generator`, `slo-architect`.

**Review & quality (ongoing)**
- `engineering-skills:adversarial-reviewer`, `engineering-advanced-skills:pr-review-expert`, `coderabbit:code-review`, `pr-review-toolkit` agents (silent-failure-hunter, type-design-analyzer, pr-test-analyzer).

**Parallelization (only for large independent workstreams)**
- `superpowers:dispatching-parallel-agents`, `subagent-driven-development`, `agent-teams:*` — used only when the user asks or work genuinely fans out; not for routine tasks.

**Continuity (situational)**
- `handoff` (session handoff), `reflect` (mid-work reassessment).

---

## Dismissed — by category (not relevant to this product)

| Category | Examples | Why dismissed |
|---|---|---|
| Scientific / bio / ML-compute | `scanpy`, `rdkit`, `biopython`, `astropy`, `pytorch-lightning`, `scikit-learn`, `pymc`, `matplotlib`/`seaborn` (as Python plotting) | This is a TS/JS web platform, not scientific computing. (Research-search skills kept above for standards work.) |
| Python-stack dev | `python-development:*`, `django-pro`, `fastapi-pro` | Stack is TypeScript/Node. Revisit only if a Python service is introduced. |
| Cloud-provider-specific | `aws-core:*`, `aws-serverless:*`, `cloudflare:*`, `firebase:*`, `gcp/azure` | Hosting is a parked decision (`VISION_AND_PLAN.md` §8). Pick up once hosting is chosen. |
| Mobile-native | `ui-design:mobile-ios-design` / `-android-design`, `react-native-design` | Web platform. Revisit only if a mobile app is scoped. |
| Unrelated domain personas | `grants`, `notebooklm`, `clinical-*`, `research-ops-skills:*`, `caveman`, `consciousness-council` | No fit to this engineering work. |
| Data-engineering / streaming | `data-engineering:*`, `astronomer-data:*` (Airflow), Kafka/Kinesis | No pipeline/streaming component in scope. |

---

*Change log: additions/removals recorded here as the project proceeds.*
