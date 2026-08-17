# docs/ — index

**Written 2026-08-18.** Every file under `docs/`, grouped by who needs it and how current it is.
Some documents here are stale or superseded; those are marked, since the filename does not say so.

## What is true as of 2026-08-18

The platform is **pre-production and nothing is deployed**. A Hetzner VPS and a Cloudflare-managed
domain are purchased; neither is configured, and the application has never served a request
outside a developer machine or CI. Four implementation plans have been executed and merged —
**1a** (isolation spine), **1b** (wiring it into the app), **1c** (evidence and framework pinning)
and **1d-i** (end-to-end suite on the CI gate); **1d-ii has not started**. Plan 1a's first five
tasks were rolled back on 2026-08-02 and redone (`DEFERRED_REGISTER.md` D-063 and its rollback
annotation). The current honest state is the **2026-08-17 audit**, not the plan of record: 195
findings, 46 re-examined by independent verifiers, verdict *"the inner ring of this platform is
genuinely excellent, and the outer shell is not built."*

## Start here

| Document | What it is |
|---|---|
| [`../README.md`](../README.md) | Repository front door: what the product is, project status, local cold start, repository layout. Rewritten 2026-08-18 and accurate as of that date. |
| [`audits/2026-08-17-full-platform-audit.md`](audits/2026-08-17-full-platform-audit.md) | **The current status record.** Read this before relying on any other document here. |
| [`VISION_AND_PLAN.md`](VISION_AND_PLAN.md) | The nominal plan of record (`AGENTS.md` names it as session-start reading). **Partly stale:** its header still reads "Draft for review (v0.1) · Last updated: 2026-07-19", it records none of plans 1a–1d-i or the rollback, and its §8 still lists "Hosting/deployment model — deferred", which the procured VPS has made false (audit DOC-09). |
| [`planning/2026-08-17-revised-vision-and-plan.md`](planning/2026-08-17-revised-vision-and-plan.md) | The proposed response to the audit. **A proposal awaiting a ruling — not a schedule, nothing in it is decided.** |
| [`../AGENTS.md`](../AGENTS.md) | The engineering operating rules every contributor follows, organised by checkpoint C1–C6 (task start, before delegating, mid-execution, on receiving work, before claiming done, phase exit). Mirrored by `CLAUDE.md`. |

## Architecture — [`adr/`](adr/)

Architecture Decision Records. [`adr/README.md`](adr/README.md) states when an ADR is required,
the format, and the status vocabulary, and carries the index table.

| ADR | Decided | Status |
|---|---|---|
| [0001](adr/0001-data-access-architecture.md) — data-access architecture | Postgres row-level security is the authoritative tenant filter; the application owns authorization and does not hand-filter by `orgId`. Two data-access lanes: tenant tables through `withOrg`, identity and consent through the deliberately narrow `identityDb`. | Accepted, 2026-08-02 |
| [0002](adr/0002-identity-and-account-linking.md) — identity, sessions, account linking | The session token asserts identity and nothing else; org membership and role are re-read from the database on each request. Also: session caps (12h/7d), `sessionEpoch` revocation, hashed invitation tokens, a branded `OrgContext`. | **Marked `Proposed`, but shipped and load-bearing** — see flag below |
| [0003](adr/0003-framework-version-registry-third-lane.md) — framework version registry | `framework_versions` is neither tenant nor identity data, so it gets a third data-access lane rather than defaulting onto the identity connection. | Accepted, 2026-08-09 |

**Known defects in these records** (audit §4 theme D; appendix DOC-04 to DOC-06):

- **ADR-0002 says `Proposed` and the index repeats it, but every decision in it is implemented and
  tested.** Recorded in the register on 2026-08-05 (D-066's closure note) and not corrected since.
  A reader who resolves conflicts by ADR status will treat the live identity model as tentative.
- **ADR-0001 and ADR-0002 contradict each other on denial codes.** ADR-0001 says unauthorised
  access to an existing resource returns 404, "never 403"; ADR-0002 and the shipped code return 403
  for a member whose role lacks the action. The code implements ADR-0002.
- **ADR-0001's layer diagram names `lib/data/context.ts`, which does not exist** — the context
  layer is `lib/auth/context.ts`.

## Operations — [`runbooks/`](runbooks/)

Three runbooks, all headed "Last updated: 2026-06-29" and all targeting the domain `rai.air.ug` on
a Hetzner VPS with Docker, nginx and Let's Encrypt.

- [`runbooks/deployment.md`](runbooks/deployment.md) — build, first deploy, TLS, DNS, redeploy,
  rollback.
- [`runbooks/backup-restore.md`](runbooks/backup-restore.md) — nightly `pg_dump`, retention,
  restore, off-site copy.
- [`runbooks/troubleshooting.md`](runbooks/troubleshooting.md) — SSL renewal, database connection
  refused, out-of-memory, and other production symptoms.

**These cannot currently produce or restore a working system, and the audit found no evidence any
of them has ever been executed** (`audits/2026-08-17-full-platform-audit.md` §3 C-1..C-4, §4 theme
A; appendix DEP-01 to DEP-10). Confirmed under adversarial verification: the deployment runbook's
first compose command reads no environment file, so Postgres gets an empty password and never
becomes healthy; the app container is never passed `APP_DATABASE_URL`, the connection the whole RLS
design runs on; production login fails with `UntrustedHost` because NextAuth v5 reads
`AUTH_TRUST_HOST`, which nothing sets outside CI; and no working path exists to run migrations or
seed in production. The backup script's error branches are unreachable under `set -euo pipefail`, it
names a container that does not exist, off-site copying is optional, and a restore onto a fresh
server silently loses the cluster-level `makrai_app` role. Container names are wrong in all three
files. Repairing them by executing them is the first item of the revised plan's T1 phase. There is
no local-development runbook; the cold start is in [`../README.md`](../README.md).

## Product and planning

- [`VISION_AND_PLAN.md`](VISION_AND_PLAN.md) — vision, the locked product decisions (primary
  adopter is team self-improvement; standards anchors are ISO/IEC 42001 and the AU Continental AI
  Strategy / UNESCO EIA), target architecture, phases 0–4. Stale as noted above.
- [`planning/2026-08-17-revised-vision-and-plan.md`](planning/2026-08-17-revised-vision-and-plan.md)
  — proposal responding to the audit; open choices surface as decision points rather than answers.
- [`planning/2026-08-12-phase1d-backlog-triage.md`](planning/2026-08-12-phase1d-backlog-triage.md)
  — triage of the 48 register rows labelled "Phase 1d" into what 1d-ii must carry and what moves.
- [`superpowers/plans/`](superpowers/plans/) — the executed implementation plans, task by task
  (`2026-06-30-verification-security` and one per sub-phase 1a, 1b, 1c, 1d-i). These and the
  register are where the executed sub-phases are actually recorded.
- [`superpowers/specs/`](superpowers/specs/) — the design spec each plan was built from.
- [`superpowers/spikes/2026-08-02-rls-prisma7-findings.md`](superpowers/spikes/2026-08-02-rls-prisma7-findings.md)
  — the spike behind ADR-0001: GO for `withOrg`, NO-GO for Prisma `$extends`.

## Assurance

- [`audits/2026-08-17-full-platform-audit.md`](audits/2026-08-17-full-platform-audit.md) — method
  and confidence boundary, verdict, five Criticals, 35 Highs by theme, what is genuinely sound, its
  own verification downgrades, what it could not establish. Report only — nothing in it is fixed.
- [`audits/2026-08-17-full-platform-audit-appendix.md`](audits/2026-08-17-full-platform-audit-appendix.md)
  — all 195 findings with evidence, citations and verification verdicts, generated from the
  structured auditor results.
- [`security/2026-08-10-registration-rate-limit-threat-derivation.md`](security/2026-08-10-registration-rate-limit-threat-derivation.md)
  — threat derivation behind the registration rate limit, preserved from a scratch workspace
  because `lib/rate-limit.ts` cites it in production code as the justification for its cap.

## Process

- [`DEFERRED_REGISTER.md`](DEFERRED_REGISTER.md) — 209 rows (D-001 to D-209) covering every
  deferral, parked decision, accepted risk, known bug and skipped process step, each with a concrete
  pick-up trigger. Rows are closed, never deleted. With the plans, the project's real history.
- [`SKILLS_INVENTORY.md`](SKILLS_INVENTORY.md) — which tooling to invoke at which moment; filed by
  checkpoint and trigger rather than by topic.
- [`COMMIT_CONVENTION.md`](COMMIT_CONVENTION.md) — adopted 2026-08-18, forward-only. Subject and
  body rules, a banned-phrase list, trailers, worked examples.
- [`process/RULE_PROVENANCE.md`](process/RULE_PROVENANCE.md) — the specific failure behind each
  rule in `AGENTS.md`. Reference material; read at phase exits and when amending the rules.

## Historical, superseded — do not rely on these

Kept because the record is the point. All predate the multi-tenant rebuild, none describes the
platform as it exists today, and the 2026-08-17 audit confirmed their headline claims are no
longer true (appendix DOC-08).

| Document | Date | Why it is superseded |
|---|---|---|
| [`ui-ux-audit.md`](ui-ux-audit.md) | 2026-07-02 | UI/UX audit of the pre-tenancy app. Its criticals ("Sidebar has zero CSS styles", "Auth pages have zero CSS styles") were since fixed — `app/globals.css` carries those rules today. |
| [`verification-bugs.md`](verification-bugs.md) | 2026-07-01 | A 22-flow runtime pass against the pre-tenancy app. The register's own audit found its rows were **stale on entry** — transcribed from `PHASE_0_FINDINGS.md` without being re-checked (D-021). |
| [`audit-phase1-phase5-findings.md`](audit-phase1-phase5-findings.md) | 2026-07-03 | Deep-scan UI audit, design-system integrity and web standards. Its "Phase 1 / Phase 5" are the audit's own internal phases and have nothing to do with this project's Phase 0–4 plan. |
| [`PHASE_0_FINDINGS.md`](PHASE_0_FINDINGS.md) | 2026-07-31 | The evidence behind the harvest-vs-redesign decision, from a live browser run against the pre-tenancy app. The decision it supported has since been taken and executed. |
| [`PHASE_1_FOUNDATION_DESIGN.superseded.md`](PHASE_1_FOUNDATION_DESIGN.superseded.md) | 2026-07-31 | The pre-implementation tenancy design. Superseded by [`superpowers/specs/2026-08-02-phase1-foundation-design.md`](superpowers/specs/2026-08-02-phase1-foundation-design.md), whose §3.1 and §3.2 were in turn superseded by ADR-0001. Its own internal status line ("Draft for sign-off (v0.1)") was never updated and is not accurate. |
| [`security-correctness-audit-2026-07.md`](security-correctness-audit-2026-07.md) | 2026-07-09 | The audit that found the systemic IDOR flaw motivating the rebuild. Self-contained and honest about its own resolution ("All of these are now fixed"), but describes an authorization model that no longer exists. |
| [`audit-screenshots/`](audit-screenshots/) | 2026-07 | Seven PNG screenshots of the pre-tenancy UI, captured for the UI/UX audits above. |
