# Contributing

This repository is private and pre-production — nothing is deployed. Read `README.md` first: its
**Project status** section states what is verified, what is known broken, and what has never been
executed. The code is licensed Apache-2.0 (`LICENSE`). This project already writes its engineering
rules down at length, in `AGENTS.md`; this file is a map to them, not a second copy of them.

## 1. Setting up

Follow **`README.md` → "Quick start (local development)"**. It covers Node 22, the Docker Postgres,
creating and migrating the second database `makrai_test`, provisioning the restricted `makrai_app`
database role, and seeding the platform admin, and it records a live defect in that path: do not run
`npm run db:migrate` on this branch. Take setup steps from that section only — the deployment and
restore procedures in `docs/runbooks/` are known to be wrong, the audit having confirmed the
documented deployment cannot produce a working system (`docs/audits/2026-08-17-full-platform-audit.md` §3).

## 2. Gates a change passes before it is proposed

| Command | Runs | Needs |
| --- | --- | --- |
| `npm run lint` | `eslint`, including this repository's own import-boundary rules (§4 below) | — |
| `npm run typecheck` | `tsc --noEmit` | — |
| `npm test` | `vitest run` | `makrai_test` migrated and provisioned |
| `npm run test:e2e` | `playwright test` | `npx playwright install`. Playwright starts and owns the server (`playwright.config.ts`); do not start one yourself first |

`npm run verify` runs `npm run lint && npm run test && npm run build` in one command — note what it
leaves out: **it runs neither `typecheck` nor the e2e suite.** `.github/workflows/ci.yml` runs two
jobs on every push and pull request, `lint, typecheck, test, build` and `e2e`, both against a real
Postgres with migrations and role provisioning applied.

## 3. Passing tests is not "done"

**This project's definition of done is live end-to-end verification in a real browser** — `AGENTS.md`
§1 C5. A green suite, a clean type-check and a successful build are inputs to that judgement, not
substitutes for it. Drive the change through the running app (the `run` skill, Playwright, or Chrome
DevTools), observe it work, and state plainly what was and was not verified live. C5 also requires the
verification command to be run *now*, in the message claiming the result — an earlier run is not
evidence about the current state.

## 4. The tenancy rule you are most likely to break

Each organization's data is isolated by Postgres row-level security, not by application filtering,
and that boundary holds only if every read and write goes through one door. **Application code
reaches tenant data only through `withOrg`** (`lib/data/tenant.ts:186`), which opens one interactive
transaction, sets a transaction-scoped setting identifying the organization, and runs as the
restricted `makrai_app` role. Never reach tenant tables through a Prisma client of your own.
Non-tenant identity data has its own lane, `identityDb` (`lib/data/identity.ts`); global framework
reference data is a third (ADR-0003). `withOrg` takes an `OrgContext`, trustworthy only when the
`requireOrgContext*` functions in `lib/auth/context.ts` minted it — `createOrgContext` is exported
but is not yours to call.

`eslint.config.mjs` enforces this, and the enforcement has more parts than it looks:

- One `no-restricted-imports` block covers `app/**/*.{ts,tsx}` and `lib/**/*.{ts,tsx}` and carries
  three ban groups at once: any import of a `db` module (`@/lib/db`, `**/lib/db`, `**/db`, `./db`,
  `../db` — relative spellings included, because a narrower list was walked straight through once);
  the `auth` named export from `lib/auth` (use `requireIdentity()` instead, ADR-0002); and
  `createOrgContext` from `lib/data/tenant`. That rule sees static `import` declarations only, so a
  parallel `no-restricted-syntax` rule bans the `import()` and `require()` forms of `db` and `auth`.
- Four narrower `files` overrides grant the sanctioned exemptions: `lib/data/**` may import a `db`
  module and `auth`; `lib/data/tenant.ts` is exempt from all three groups; `lib/auth/identity.ts`
  may import `auth`; `lib/auth/context.ts` may import `createOrgContext`. Each override *restates*
  the groups that still apply rather than switching the rule off, because ESLint flat config
  **replaces** a rule's options per matching config object instead of merging them.
- That replacement behaviour once silently deleted the `db` and `auth` bans while `npm run lint` stayed
  at zero problems, so `__tests__/lint/effective-config.test.ts` pins the *resolved* config read from
  `npx eslint --print-config` rather than the source text, and
  `__tests__/integration/port-completeness.test.ts:28` greps the tree for any file outside `lib/data/`
  importing a `db` module. No `lib/db` module exists today; the ban keeps it from returning.

## 5. Commit messages

`docs/COMMIT_CONVENTION.md` is the full convention, bound to `AGENTS.md` §1 C7 ("Before committing")
and applying forward-only from 2026-08-18 — earlier commits are not evidence it was ignored. It also
fixes the eight allowed types and the closed set of scopes, and works through six examples from this
repository's own history, including bad ones with rewrites. Its two hard rules:

1. **The subject is one line of at most 72 characters and contains no identifier** — no register row
   ID, no ADR number, no checkpoint code, no "Task N", no "round N". Those are pointers that eat the
   characters a reader scans while saying nothing; put them in the body or a `Refs:`/`ADR:` trailer.
2. **Describe the change, never the doing of the change.** No first person, no "this session", no
   "the brief", no cast of implementers and reviewers, no quoted conversation, no path under a
   gitignored directory — three published commits cite `.superpowers/` paths whose evidence is now
   unrecoverable by anyone. Naming a method as re-checkable evidence is fine; narrating who did what
   is not.

## 6. Record what you decided not to do

Every conscious decision to not-do-something-now — a deferral, a parked decision, an accepted risk, a
known bug, or a triggered process step you skipped — **gets a row in `docs/DEFERRED_REGISTER.md` in
the same commit that creates it**, with the reason and a concrete pick-up trigger. "Later" is not a
pick-up trigger. Rows are closed, never deleted, and a closure cites the commit and states what was
verified live. This is `AGENTS.md` §6; a to-do item does not discharge it, because to-do items are
session-local and evaporate. Opening a row on "I cannot" grounds needs the same evidence as closing one:
the command and its output, or the source you read.

## 7. Architecture decisions

`docs/adr/README.md` documents the process and holds the index. Write an ADR when a decision shapes
how components interact or where a responsibility lives, is expensive to reverse (schema shape,
tenancy model, auth strategy, API surface), has a plausible alternative a future reader would
otherwise re-litigate, or was contested and resolved — in which case record why the losing option
lost. Routine implementation choices with an obvious default do not need one. Files are named
`NNNN-short-kebab-title.md`, numbered sequentially, with sections Context · Decision · Consequences
(positive and negative/accepted) · Alternatives rejected · References; status is one of `Proposed`,
`Accepted`, `Superseded by ADR-NNNN`, `Deprecated`. **An ADR is never edited to change its decision**
— supersede it with a new record and update the old one's status. Keeping what the project used to
believe is the point of the format.

## 8. The full ruleset

`AGENTS.md` (mirrored by `CLAUDE.md`) is the operating document for this repository, written for
human and AI contributors alike — the same rules bind both. It is organised by checkpoint rather than
by topic: task start, before delegating, mid-execution, on receiving work, before claiming something
is done, phase exit, before committing. Each rule names an observable event that makes it fire, because
the project measured that rules without a trigger do not fire at all. Nearly every one was written in
response to a specific failure here, and `docs/process/RULE_PROVENANCE.md` holds that evidence — the
incident, the date, the measurement and the register row behind each rule — so `AGENTS.md` can stay
short enough to re-read whole. Read provenance at phase exits and when amending a rule, not to start.
