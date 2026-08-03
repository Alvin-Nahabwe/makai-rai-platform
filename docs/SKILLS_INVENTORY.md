# Skills Inventory — MAK-AI RAI Toolkit

**Status:** v0.2 · Companion to `AGENTS.md` and `VISION_AND_PLAN.md`
**Restructured 2026-08-03** at the Plan 1a exit, after an audit measured which skills actually fired.

---

## §0 — How this document works, and why it is shaped this way

### The measurement that forced the rewrite

At the Plan 1a exit every skill named in v0.1 was checked against the SDD ledger and the branch's
commits. The result was not ambiguous:

| Fired reliably | Never fired |
|---|---|
| `security-review` (13), `database-design:postgresql` (12), `senior-security` (10), `verification-before-completion` (9), `what-if-oracle` (7), `test-driven-development` (6) | `code-review` (0), `code-simplifier`/`simplify` (0), `systematic-debugging` (0 — one *declination*), `adversarial-reviewer` (0), `silent-failure-hunter` (0), `env-secrets-manager` (0) |

**Every skill in the left column is named in an `AGENTS.md` checkpoint, in the §2 trigger table, or
in the `UserPromptSubmit` hook. Not one in the right column is.** 8 of 8 bound skills fired; 0 of 6
unbound ones did. Being listed in this document under "Tier 1 — always-on" had no measurable effect.

That is the same law `AGENTS.md` §0 was rewritten around:

> **A skill that is not bound to an observable moment will not be invoked. Calling it "always-on"
> does not bind it.**

v0.1 was organised by *topic* with prose triggers ("after each meaningful code chunk"), which is
precisely the recall-dependent shape that failed. This version is organised by *moment*.

### Maintenance rules (these are rules, not preamble)

1. **Every entry names the moment it fires.** An entry whose trigger is a topic rather than an event
   is rejected — find its moment or leave it out.
2. **A skill in §1 must also be named in the corresponding `AGENTS.md` checkpoint.** This document
   alone does not bind anything; the audit above is the proof. If you add to §1, amend `AGENTS.md`
   in the same commit or the entry is decorative.
3. **Verify availability at the point of use.** The visible pool shifts between sessions as plugins
   and MCP servers connect. Names here are the ones observed on 2026-08-03; see §4.
4. **Re-audit at every phase exit** the same way this one was done: grep the ledger and the branch
   commits for each named skill, and compare bound against unbound. Do not re-derive the conclusion
   from memory.

---

## §1 — Bound to a checkpoint (the always-on tier)

These fire at a specific checkpoint in `AGENTS.md` §1. The checkpoint column is the binding.

| Skill | Fires at | What it is for |
|---|---|---|
| `rigor-loop` | **C1**, and any analysis or decision the user will act on | Framing, evidence, bias, self-critique. Runs silently on light tasks. |
| `superpowers:brainstorming` | **C1**, before any feature/behaviour work | Explore intent before building. Not needed when executing an approved plan. |
| `superpowers:writing-plans` | **C1**, once a spec exists | Spec → staged, bite-sized plan. |
| `superpowers:subagent-driven-development` | **C1** of a plan with independent tasks | Sequencing only. **Discharges nothing else** (§1 C1). |
| `engineering-skills:senior-security` | **C1** of every task touching auth, tenancy or data access | The *preventive* half of §7.1. Derive obligations fresh per task. |
| `database-design:postgresql` | **C1** of any schema, migration, index, RLS or role change | Postgres mechanics. |
| `superpowers:test-driven-development` | **C1→C4**, before implementation code | Red before green; assertions must be non-vacuous. |
| **`code-review:code-review`** | **C4**, on receiving any code chunk — **NEWLY BOUND** | Correctness/quality of the diff. **An SDD reviewer subagent does not discharge this** — that substitution caused D-063 and recurred in the redo (D-083). |
| **`simplify`** (or `code-simplifier`) | **C4**, after `code-review` on a chunk you are keeping | Clarity and altitude. Quality only — it does not hunt bugs. |
| `superpowers:verification-before-completion` | **C5**, before any completion claim | Evidence before assertion; run the command in this message. |
| `run` | **C5**, when the claim involves the app behaving | Drives the real app. Prefer over hand-rolled curl/browser steps. |
| `security-review` | **C6**, over the whole branch diff | The *detective* half of §7.1. Found both fail-opens Plan 1a shipped (D-080, D-081). |
| `superpowers:finishing-a-development-branch` | **C6**, when the branch is ready to merge | **NEW** — was absent from v0.1 and is needed now. |

---

## §2 — Bound to a mid-execution trigger

These fire on the observable conditions in `AGENTS.md` §2, not on a schedule.

| When you notice… | Invoke |
|---|---|
| Something failed, behaves unexpectedly, or you are about to work around it | **`superpowers:systematic-debugging`** — **NEWLY BOUND.** Declined once at Task 0 for a good reason, then never reconsidered through four real debugging episodes (Turbopack panics, Chrome's Qt failure, `npm run seed`, a psql `-c` error). The trigger table said "investigate" but named no skill (D-084). |
| You reach a hard-to-reverse fork — data model, tenancy, identity, scoring | `what-if-oracle`. Mandatory at these forks. |
| You are about to write anything that gates access | `engineering-skills:senior-security` now, not at the end. |
| You are writing error handling, a fallback, a catch, or a default | **`pr-review-toolkit:silent-failure-hunter`** (an **Agent**, see §4) — **NEW.** Both Plan 1a fail-opens were silent fallbacks; this is the most on-point unused tool in v0.1 (D-085). |
| You are handling a credential, connection string, `.env`, or provisioning script | **`engineering-advanced-skills:env-secrets-manager`** — **NEW.** Not invoked during Task 4's role/credential work, where a committed migration would have published a production password. |
| A module bypasses a security control, or you are reviewing your own security work | **`engineering-skills:adversarial-reviewer`**, or an independent reviewer — **NEW.** Self-review missed both C6 defects; one independent pass found both (D-082). |
| You are about to hand off, pause, or end a session mid-task | `handoff` |
| You are deep in detail and unsure the direction still holds | `reflect` |
| You are about to touch Next.js APIs, routing, or config | **`modern-web-guidance:modern-web-guidance`** — **NEW.** `AGENTS.md`'s opening line says this Next.js differs from training data; v0.1 had no skill for it. |

---

## §3 — Workstream skills, with entry conditions

These fire when you **enter** an area, which is an observable event. Zero invocations while an area
is untouched is the inventory working, not a gap — Plan 1a legitimately fired none of the UI,
accessibility, artifact or CI entries because it shipped no UI, no routes and no reports.

**Entering data-model or migration work**
`database-design:postgresql` · `engineering-advanced-skills:database-designer` ·
`engineering-advanced-skills:database-schema-designer` · `sql-pro` ·
`engineering-advanced-skills:migration-architect` · `mattpocock-skills:domain-modeling` *(new)*

**Entering architecture or an ADR**
`engineering-skills:senior-architect` · `backend-development:architecture-patterns` ·
`mattpocock-skills:codebase-design` *(new)* · `engineering-skills:tech-stack-evaluator`

**Entering an unfamiliar area of the codebase**
`engineering-advanced-skills:codebase-onboarding` · `monorepo-navigator` · `code-to-prd` *(new — recovers requirements from the existing SPA)*

**Entering API or route work (Plan 1b)**
`engineering-skills:senior-backend` · `backend-development:api-design-principles` ·
`engineering-advanced-skills:api-design-reviewer` · `api-test-suite-builder` ·
`postman:*` *(auth-gated, see §4)*

**Entering security work beyond the always-on pass**
`engineering-skills:senior-secops` · `security-pen-testing` · `red-team` · `threat-detection` ·
`engineering-skills:ai-security` *(if the platform itself uses models)* ·
`engineering-advanced-skills:dependency-auditor` · `env-secrets-manager` / `secrets-vault-manager`

**Entering frontend or UI**
`frontend-design` · `engineering-skills:senior-frontend` · `ui-design:create-component` ·
`design-system-setup` · `design-review` · `responsive-design` · `interaction-design` ·
`visual-design-foundations` · `ui-design:web-component-design`

**Entering anything a user sees (accessibility is not optional on an RAI tool)**
`ui-design:accessibility-audit` / `accessibility-compliance` · `chrome-devtools-mcp:a11y-debugging`

**Verifying live behaviour**
`chrome-devtools-mcp:chrome-devtools` (+ `troubleshooting`, `debug-optimize-lcp`,
`memory-leak-debugging`) · Playwright MCP tools · the `run` skill.
*Note from experience: Playwright's Chrome failed to launch here on a Qt platform-plugin error while
the chrome-devtools MCP worked. Try the other launcher before concluding "no browser".*

**Entering artifact generation (Phase 2 — the primary-adopter payoff)**
`docx` · `xlsx` · `pdf` · `pptx` · `markdown-mermaid-writing` · `scientific-schematics` ·
`dataviz` · `artifact-design` / `artifact-capabilities` *(new — for publishing a report as a page)*

**Entering user-facing copy or generated prose**
`humanizer` — **user-facing copy and generated-document prose only; never code or internal docs.**

**Entering standards / framework-content work**
`research-lookup` · `literature-search-openalex` / `-arxiv` / `-europepmc` · `citation-management`

**Entering benchmarking or scoring analysis (Phase 3)**
`statistical-analyst` *(new)* · `data-quality-auditor` *(new)* · `dataviz`

**Entering CI/CD, release or ops (Phase 4)**
`engineering-advanced-skills:ci-cd-pipeline-builder` · `release-manager` · `changelog-generator` ·
`observability-designer` · `runbook-generator` · `slo-architect` ·
`engineering-advanced-skills:ship-gate` *(new — relevant now: `npm run verify` is red, D-070)*

**Entering register / debt triage**
`engineering-advanced-skills:tech-debt-tracker` *(new — the register carries 67 open rows)*

**Review and quality (on any substantial diff)**
`engineering-skills:adversarial-reviewer` · `engineering-advanced-skills:pr-review-expert` ·
`coderabbit:code-review` · `superpowers:requesting-code-review` / `receiving-code-review` *(new —
these are the actual review skills the SDD loop should be using)* · `pr-review-toolkit` **agents**
(see §4)

**Parallelisation** — only when work genuinely fans out or the user asks
`superpowers:dispatching-parallel-agents` · `agent-teams:*`

---

## §4 — Invocation mechanics (v0.1 got this wrong)

- **Skills** are invoked with the `Skill` tool by exact name (`plugin:skill`).
- **`pr-review-toolkit:silent-failure-hunter`, `type-design-analyzer`, `pr-test-analyzer`,
  `comment-analyzer`, `code-reviewer`, `code-simplifier` are AGENTS, not skills.** They are
  `subagent_type` values for the `Agent` tool. v0.1 listed them among skills, which is why
  "invoke the skill" would have failed for them. `pr-review-toolkit:review-pr` *is* a skill.
- **`verify` is not a skill.** v0.1's "`verification-before-completion` + `verify` + `run`" named a
  tool that does not exist. `run` and `review` do exist.
- **Auth-gated and currently unavailable:** `postman:*`, `cloudflare:*`, `huggingface-skills:*`,
  `prisma:Prisma-Remote`. These need authorising via claude.ai connector settings or `claude mcp`
  in an interactive session; treat as unavailable until then rather than as missing.
- **MCP tool ≠ skill.** Using the chrome-devtools MCP tools directly is not the same as invoking
  `chrome-devtools-mcp:chrome-devtools`. Both are legitimate; only the latter counts as a skill
  invocation for the ledger.

---

## §5 — Dismissed, by category

| Category | Examples | Why |
|---|---|---|
| Scientific / bio / ML-compute | `scanpy`, `rdkit`, `biopython`, `astropy`, `pytorch-lightning`, `scikit-learn`, `pymc` | TS/JS web platform, not scientific computing. Research-search skills retained in §3 for standards work. |
| Python-stack dev | `python-development:*`, `django-pro`, `fastapi-pro` | Stack is TypeScript/Node. Revisit only if a Python service is introduced. |
| Cloud-provider-specific | `aws-core:*`, `aws-serverless:*`, `cloudflare:*`, `firebase:*` | Hosting is a parked decision (`VISION_AND_PLAN.md` §8). Pick up when hosting is chosen — this is also D-079's and D-076's trigger. |
| Mobile-native | `ui-design:mobile-ios-design` / `-android-design`, `react-native-design` | Web platform. |
| Unrelated domain personas | `grants`, `notebooklm`, `clinical-*`, `research-ops-skills:*`, `caveman` | No fit to this engineering work. |
| Data-engineering / streaming | `data-engineering:*`, `astronomer-data:*`, Kafka/Kinesis | No pipeline component in scope. |
| Superseded | `consciousness-council` | Its deliberation mechanism is absorbed by `rigor-loop` step 3. |

---

## §6 — Change log

- **v0.2 (2026-08-03)** — Restructured by moment after the Plan 1a exit audit measured that 8/8
  checkpoint-bound skills fired and 0/6 unbound ones did. Bound `code-review`, `simplify`,
  `systematic-debugging`, `silent-failure-hunter`, `env-secrets-manager`, `adversarial-reviewer`,
  `finishing-a-development-branch` and `modern-web-guidance` to specific moments. Added §4 after
  finding that v0.1 listed agents as skills and named a non-existent `verify` skill. Added
  `mattpocock-skills:*`, `artifact-design`, `ship-gate`, `tech-debt-tracker`, `code-to-prd`,
  `statistical-analyst`, `data-quality-auditor`, `requesting-code-review`/`receiving-code-review`.
- **v0.1 (2026-08-01)** — Initial triage into always-on and workstream tiers.
