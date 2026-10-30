# MAK-AI Responsible AI Toolkit — platform

A multi-tenant platform for responsible-AI (RAI) governance, for any organization that builds or
deploys AI systems and needs to show — not merely assert — that it governs them responsibly. It is
designed around the needs of **African research organizations**, which is where its framing,
standards anchors and worked examples come from, but nothing in it is specific to universities or
to academia.

(This line read "built for African university teams" until 2026-08-31. That was narrower than the
tool: a research institute, a government statistics office, a hospital data unit and an NGO
analytics team are all in scope, and the university framing quietly told each of them this was not
for them.)

An institution registers an organization, describes its AI systems as projects, runs structured
assessments against a versioned RAI framework (3 lifecycle stages, 21 risk areas, 28 controls,
8 principles, 78 questions — counted from `data/assessmentAreas.json` and
`data/questionBank.json`), attaches evidence to answers, and produces reports. Each
organization's data is isolated at the database level, not by application filtering.

The intended primary adopter is a **team improving its own practice**, ahead of institutional
assurance and the cross-institutional research corpus (`docs/VISION_AND_PLAN.md` §3.1). The
durable goal is that RAI evidence accumulates in one place and the governance artifacts a team
needs are generated from it, rather than a score being self-attested once and filed away. This
repository is not the product currently in public use: that is a static, anonymous,
single-browser SPA at `makrai.netlify.app` (`docs/VISION_AND_PLAN.md` §1), still live and not
yet superseded.

## Project status — 2026-08-18

**Pre-production. Nothing is deployed.** A Hetzner VPS and a Cloudflare-managed domain have been
purchased; neither is configured, and the platform has never served a request outside a
developer machine or CI.

A full audit completed on 2026-08-17 (kept with the maintainers) recorded 195
findings, 46 re-examined by independent verifiers briefed to refute them. Its verdict, quoted:
*"The inner ring of this platform is genuinely excellent, and the outer shell is not built."*
Read it before relying on anything here.

- **Sound and verified** (audit §5): Postgres row-level security as the tenant boundary, checked
  live against the system catalog; the role/permission layer; framework-version pinning; the
  evidence row layer; the CI pipeline.
- **Not yet true**: the documented production deployment fails at four independently confirmed
  points before a first login, and that path has never been executed (audit §3, C-1..C-4). The
  assessment page can discard answers silently when a save is refused (§4, theme B). A scoring
  defect caps one principle near 31/100 on perfect answers (§3, C-5). Several user-visible
  promises have no implementation behind them — the privacy page's data controls, the
  forgot-password instructions, the remediation loop's writer (§4, theme D).
- **Against the vision**: none of the five shifts in `docs/VISION_AND_PLAN.md` §2 is fully
  delivered. What exists is, functionally, the SPA plus accounts, tenancy, evidence upload, and
  framework version pinning.

A plan responding to the audit is proposed — not ruled on — in
a plan kept with the maintainers. Last full CI run on `main`, both required
jobs including live end-to-end: green, 2026-08-13.

**What runs today:** registration and credentials login; organizations with invitations and five
roles; projects; versioned assessments with autosave, completion and a report; evidence upload
and download; PDF export; project comparison; framework and control browsing; a platform-admin
user list. Twenty-two API routes under `app/api/`, tenant routes under `app/api/v1/orgs/[slug]/`.

## Standards this implements

Two anchors are locked product decisions, not aspirations (`docs/VISION_AND_PLAN.md` §3.2):

- **ISO/IEC 42001:2023** — AI management systems; the international anchor for
  organization-level governance.
- **African Union Continental Artificial Intelligence Strategy** (adopted July 2024, Accra) — the
  Global-South anchor, chosen because it is the authoritative continental instrument and because
  it explicitly calls for African-led AI assessment and evaluation tools, which is what this is.
- **UNESCO Ethical Impact Assessment (EIA)** — the impact-assessment method the AU strategy
  points to, and the one this instrument is modelled on. UNESCO's 2021 Recommendation on the
  Ethics of AI underpins the framework's 8 principles (`data/projectConfig.json`); the derivation
  of those 8 from UNESCO's 10 is recorded in `docs/adr/0004-eight-principles-from-unesco-ten.md`.

  **Not the Readiness Assessment Methodology (RAM).** RAM was previously listed here as a source
  and it does not belong: RAM assesses a *country's* readiness to govern AI — legal, institutional
  and infrastructural capacity — not an individual AI system. Naming it implied a lineage this
  toolkit does not have. Removed on 2026-08-31 after the 2026-08-18 content audit.

Framework content is additionally sourced from NIST SP 1270, the NIST AI RMF, and the EU AI Act.
**The crosswalk mapping the 21 areas and 28 controls onto ISO 42001 and the AU strategy is not
built** — the audit found it has no structural trace in the codebase (§4, theme E).

## Quick start (local development)

**Prerequisites:** Node 22 (`.nvmrc`; `package.json:5` declares `engines.node >= 22`), Docker with
Compose, `npx`. All commands run from the repository root.

```bash
npm ci
cp .env.example .env          # .env is gitignored; .env.example is the template
npm run docker:up             # docker compose -f docker/docker-compose.yml up -d
```

`docker:up` starts Postgres 16 on `localhost:5432` and creates the `makrai` database only. The
test database is created by nothing in this repository — create it once:

```bash
docker exec -i docker-postgres-1 psql -U makrai -c 'CREATE DATABASE makrai_test'
```

`docker-postgres-1` is the container name Compose derives from the `docker/` directory; it is
also the default hardcoded in `scripts/provision-app-db-role.sh`.

Apply migrations to **both** databases. Four of them run `CREATE ROLE`, `CREATE EVENT TRIGGER`
and `ALTER DEFAULT PRIVILEGES`, which are superuser-only, so they connect as `makrai`:

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" \
  npx prisma migrate deploy
```

> **Known defect — do not use `npm run db:migrate` on this branch.** That script is
> `npx prisma migrate dev`, which replays migration history into a throwaway shadow database.
> `prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:31` runs
> `REVOKE ALL ON "_prisma_migrations" FROM makrai_app;` — a table that never exists in a shadow
> database — so the replay fails with P3006/P3018. Recorded as row D-109 in
> the maintainers' decision register. `migrate deploy`, the command CI runs at `.github/workflows/ci.yml:155`,
> creates no shadow database and is unaffected.

Then provision the restricted application role, seed the platform admin, and start the app:

```bash
npm run db:provision          # sets the makrai_app and makrai_identity dev passwords on makrai and makrai_test
npm run db:seed               # creates the platform admin from ADMIN_EMAIL / ADMIN_PASSWORD in .env
npm run dev                   # http://localhost:3000
```

- The `makrai_app` and `makrai_identity` roles are created by migration **without a password**,
  on purpose: a password committed in a migration would publish the production credential.
  `db:provision` exists as a separate step for that reason (`scripts/provision-app-db-role.sh:1-18`),
  and sets `ALLOW_DEV_DB_PASSWORD=1`, without which the script refuses the dev passwords.
- `db:seed` needs `ADMIN_PASSWORD` set in `.env` to a real secret: it refuses (exit 1, naming the
  variable) when it is empty, and refuses the two literals this repository once shipped. It never
  generates a password and never prints one or the admin's address, because the migrator container's
  output goes to the host journal (`prisma/seed.ts`, `resolveAdminPassword`).
- The app refuses to start on missing configuration rather than guessing: absent
  `APP_DATABASE_URL` or `IDENTITY_DATABASE_URL` throws at `lib/data/connection.ts:39-45`, either
  naming a superuser or BYPASSRLS role stops the server at start (`instrumentation.ts`,
  ADR-0009), and absent `NEXTAUTH_SECRET` throws at `lib/auth/secret.ts:43-51`. Copying
  `.env.example` satisfies all of them locally — and its `makrai_dev_password` /
  `app_dev_password` / `identity_dev_password` defaults are deliberately public dev/CI values
  that must never reach production, for reasons the file itself sets out at length.

## Architecture in brief

| Concern | Mechanism | Decision record |
| --- | --- | --- |
| Tenant isolation | Postgres RLS. Tenant reads and writes go through `withOrg` — one interactive transaction that sets a transaction-scoped GUC and runs as `makrai_app` (`NOSUPERUSER`, `NOBYPASSRLS`). Identity, consent and the pre-organisation lookups use the identity lane, `makrai_identity` (no superuser, no tenant record table); global reference data is a third lane. | [ADR-0001](docs/adr/0001-data-access-architecture.md), [ADR-0003](docs/adr/0003-framework-version-registry-third-lane.md), [ADR-0009](docs/adr/0009-identity-lane-role.md) |
| Authorization | Application-side, and deliberately *not* the isolation mechanism: `can(role, action)` over 23 actions × 5 roles (`lib/authz/policy.ts:3-11,86`), each route declaring the action it consults (`lib/authz/routeActions.ts:22`). | [ADR-0001](docs/adr/0001-data-access-architecture.md) |
| Identity and sessions | NextAuth v5, credentials provider only. The session token asserts identity and nothing else — no role or permission claims travel in it. | [ADR-0002](docs/adr/0002-identity-and-account-linking.md) — status *Proposed*, though load-bearing |
| Framework content | Four JSON files hashed as raw bytes into a version registry; each assessment pins the version it was answered against, and content drift is refused rather than silently absorbed (`lib/framework/bundleHash.ts:18-23`). | [ADR-0003](docs/adr/0003-framework-version-registry-third-lane.md) |
| Evidence | File bytes stored in Postgres under RLS with composite foreign keys and no `UPDATE` grant, making rows write-once at the database level (`prisma/schema.prisma:340-407`). | — |

Roles, descending in capability: `owner`, `admin`, `assessor`, `reviewer`, `viewer`
(`prisma/schema.prisma:258-264`). `reviewer` currently holds viewer-equivalent capabilities; its
distinguishing powers belong to a review workflow that is not built, and inventing them early was
rejected as speculative (`lib/authz/policy.ts:17-19`).

Stack: Next.js 16.2.9 (App Router), React 19.2, Prisma 7 with the `pg` adapter, PostgreSQL 16,
NextAuth v5 beta, `@react-pdf/renderer` for report export, Recharts, Resend for mail.

## Testing

| Command | Runs | Needs |
| --- | --- | --- |
| `npm test` | Vitest — 53 files across unit, integration, engine, authz and lint-rule suites | A migrated and provisioned `makrai_test`. Connection strings default at `vitest.config.ts:18-29`; override with `TEST_DATABASE_URL` / `TEST_APP_DATABASE_URL` / `TEST_IDENTITY_DATABASE_URL` |
| `npm run test:e2e` | Playwright — 8 specs, including a 20-user role matrix and a two-organization isolation walk | Browsers installed (`npx playwright install`). Playwright starts and owns the server (`playwright.config.ts:22-28`); do not start one first |
| `npm run test:security` | `scripts/pen-test.mjs`, an HTTP probe suite | An app already serving on `http://localhost:3000` (override with `TEST_URL`) |
| `npm run typecheck` | `tsc --noEmit` | — |
| `npm run lint` | ESLint, including this project's own import-boundary rules | — |
| `npm run verify` | `lint && test && build` | Same as `npm test` |

Integration tests run serially (`vitest.config.ts:9-15`): they share one database and truncate it
between files. `__tests__/helpers/db.ts` refuses to run against any database but `makrai_test`.

At the 2026-08-17 audit, Vitest reported 1579 of 1579 passing in about 52 seconds and Playwright
collected 49 tests, one quarantined via `test.fixme` (audit §1). Both CI jobs run against a real
Postgres with migrations and role provisioning applied (`.github/workflows/ci.yml`).

## Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js App Router — `(public)/` unauthenticated pages, `(authenticated)/` the product, `api/` the HTTP surface |
| `components/` | React components: assessment, dashboard, evidence, layout, report |
| `lib/` | Server logic — `data/` (the three data-access lanes), `authz/`, `auth/`, `engine/`, `evidence/`, `framework/`, `pdf/`, `report/`, `email/` |
| `data/` | The RAI framework content: areas, controls, question bank, scoring config. Hashed as a unit, so a reformat counts as a content change |
| `prisma/` | `schema.prisma`, 14 migrations, the admin seed |
| `__tests__/` | Vitest suites, including `integration/trigger-enumeration.test.ts`, which fails when a guard or gating column has no production caller |
| `e2e/` | Playwright specs and the shared multi-user fixture |
| `docker/` | Dev Compose (Postgres only), production Compose, Dockerfile, nginx config |
| `scripts/` | `provision-app-db-role.sh`, the pen-test probe, an audit-coverage helper |
| `docs/adr/` | Architecture decision records; index at `docs/adr/README.md` |
| `docs/runbooks/` | Deployment, backup and restore, troubleshooting — see the caution below |

## Where to find things

- **Product direction** — `docs/VISION_AND_PLAN.md`, the plan of record. The five shifts (§2) and
  the locked decisions (§3) are the parts that constrain design. Its §8 still calls hosting
  "deferred", which the procured VPS has made false.

## Licence

**Apache License 2.0** — see [`LICENSE`](LICENSE). Chosen on 2026-08-18: permissive, with an
explicit patent grant, which is the combination that lets an institution adopt, extend, or
self-host the toolkit without a legal review of the terms. The patent grant matters
specifically because this project encodes a scoring methodology.

Before this date the project carried no licence at all, which meant the default of *all rights
reserved* — no institution could legally adopt or fork it, contradicting the adopter model in
[`docs/VISION_AND_PLAN.md`](docs/VISION_AND_PLAN.md) §3.1.

> **Open item:** the copyright line in `LICENSE` names an individual, because that is the only
> attribution derivable from the repository itself. If copyright in this work belongs to
> Makerere University or another institution, that line must be corrected before the code is
> shared outside the project.
