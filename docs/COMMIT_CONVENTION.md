# Commit convention

Adopted **2026-08-18**. Forward-only — see §8.

## 1. Why this exists

The repo's message quality changed on a date. Of 237 non-merge commits, the 51 written before
2026-08-01 are short and mostly bodyless; the 186 written from 2026-08-01 onward all carry bodies
averaging 29 lines (median 26), and 182 of them have subjects over 50 characters, 96 over 72, the
longest 145. Length is not the defect — what fills it is. Only 50 of those 186 bodies (27%)
contain a `file.ext:line` citation or a shell command in backticks, which `AGENTS.md §5` already
demands ("Cite the file and line, or the command and its output, for load-bearing claims"). What
occupies the rest is session narrative: 44 commits use first person, 22 mention "the human
partner", 23 "the brief", 21 "round N", 2 "compaction", and 6 cite paths under the gitignored
`.superpowers/` directory that no longer exist. The record is written for someone who was in the
room, and nobody is in the room six months later.

Until 2026-08-18 there was also no mechanism at all — no `CONTRIBUTING.md`, no `.gitmessage`, no
`commit.template`, no `core.hooksPath`, no non-sample hook in `.git/hooks/`, and — the part that
mattered most by this project's own doctrine — **no checkpoint that fired at `git commit`**.
`AGENTS.md §0` states the law this document was failing: *"An obligation that names no observable
trigger will not fire."* Commit-message quality had never had a trigger, which is a complete
explanation of the measurements above and is why a style document alone would have changed
nothing.

**This document is now bound to `AGENTS.md §1 C7` ("Before committing").** C7 carries the reading
obligation — the half no grep can check, namely whether a message describes *the change* or *the
doing of the change*. A token check can catch the banned list mechanically; it cannot catch that.
Both are needed, which is the same split `AGENTS.md §2` already records for
`trigger-enumeration.test.ts`.

## 2. The subject rule

```
type(scope): imperative description
```

One line, **≤72 characters hard**, ≤60 preferred. Imperative mood ("add", not "adds"). Lowercase
after the colon unless the first word is a proper noun (`Playwright`, `AGENTS.md`, `FORCE`). No
trailing period.

**No identifier in the subject** — no `D-nnn`, no `O-nn`, no `C1`–`C6`, no "Task N", no "round N".
Those are pointers. They consume the 72 characters a reader scans while telling that reader
nothing. They go in the body (qualified) or in a `Refs:` trailer.

### Types — closed set of eight

`feat` · `fix` · `docs` · `test` · `refactor` · `chore` · `ci` · `perf`

Seven others are in use. Migrate them (counts from
`git log --all --no-merges --format='%s' | grep -oE '^[a-zA-Z]+' | sort | uniq -c`):

| In use now | Count | Use instead |
|---|---|---|
| `process` | 12 | `docs(agents)` — these edit the operating rules |
| `spike` | 3 | `chore` |
| `plan` | 2 | `docs(plan)` |
| `design` | 2 | `docs(adr)` or `docs(spec)` |
| `infra` | 2 | `ci`, or `chore` if it is not pipeline work |
| `db` | 2 | `feat(db)` / `fix(db)` — a schema change is a feature or a fix |
| `quarantine` | 1 | `test` |

### Scopes — closed set, **area only**

`tenancy` · `authz` · `auth` · `data` · `db` · `api` · `ui` · `e2e` · `ci` · `email` · `deps` ·
`register` · `adr` · `plan` · `spec` · `agents` · `audit`

Omit the scope rather than invent one. 35 distinct scopes are in use today, mixing four
incompatible axes, and 61 commits carry none at all.

**Phase scopes are banned** — `1c` (35 uses), `1d-i` (6), `plan-1c` (2). A phase name states a
schedule that stops existing once the schedule moves on, and the phase is recoverable anyway from
the commit date and the merge commit that landed it.

**Register row IDs as scopes are banned** — `fix(D-192)`, `fix(D-146)`. A scope names the part of
the system a change touches; a row ID names bookkeeping *about* the change. Putting one in the
other's slot makes the scope vocabulary unbounded (209 rows and growing). Row IDs go in `Refs:`.

## 3. The body rule

Optional for a one-line obvious change, expected otherwise. Blank line after the subject.

- **Hard wrap at 72 columns.** 40% of current body lines exceed 72 (max 93) — wrapped for a wide
  terminal, not for `git log`, which indents bodies by four spaces at any width.
- **Say why, and say what the diff cannot show.** The diff already says what changed. The body
  says what breaks without it, what was rejected, what is deliberately out of scope, and what the
  change now makes possible.
- **Every load-bearing claim carries a `file:line` or a command and its output** — already
  required by `AGENTS.md §5`, currently honoured in 27% of bodies.
- **Qualify every identifier on first use**, naming the file that defines it: `AGENTS.md §1 C4`
  not `C4` (20 of 38 commits citing `C1`–`C6` never name `AGENTS.md`); `D-165 (DEFERRED_REGISTER)`
  not `D-165` (64 of 144 never name the register); `Plan 1c Task 5`, the plans being tracked at
  `docs/superpowers/plans/` (39 of 91 commits saying "Task N" name no plan or phase anywhere);
  `ADR-0002`, tracked at `docs/adr/`. The test is not "could a determined reader find it" but
  "does the message say where to look".
- **Three or four short paragraphs is the norm.** Past ~20 lines, either the commit is doing too
  much or narrative is leaking. Check which.

## 4. The banned list

**The distinguishing test: describe the change, never the doing of the change.**

Naming a skill or method as *evidence* is good — "what-if-oracle on the decomposition found five
seam defects" is a re-checkable fact about how a conclusion was reached. Naming an agent as a
*character in a story* is not — "Task 3's implementer attempted to invoke code-review, had the
tool call rejected, and then treated my interruption as substituting for the checkpoint" is a plot
summary of a session nobody can replay.

| Banned | Why |
|---|---|
| First person — `I`, `my`, `me`, `we`-as-session | The record has no narrator. 44 commits. |
| "this session", "in conversation" | Names a container the reader cannot open. |
| "before compaction" | A session-management event, not a reason to change code. 2 commits. |
| "asked whether…", "caught while…" | Opens on the asking, not on the change. |
| "the brief", "the task brief" | Unresolvable — briefs are not tracked. 23 commits. |
| "the implementer", "the reviewer", "the controller" | Cast list. Say what changed. |
| "the human partner ruled…" | Write `Ruling:` and the ruling, or point at the register row. 22 commits. |
| "round N" | Anchors to nothing in the repo at all. 21 commits. |
| Quoting conversation verbatim | A chat message is not a durable artifact. |
| Any path under a gitignored directory | The path is dead on arrival. |

The last one has already cost this repo permanently. Three published commits cite evidence inside
`.superpowers/`, which `git ls-files .superpowers` shows is entirely untracked — and all three
paths are gone from disk:

- `2adf381` → `.superpowers/sdd/2026-08-10-phase1d-i-e2e-trustworthy/task-4-derivation.md`
- `3114fb7` → `.superpowers/sdd/2026-08-06-phase1c-evidence-and-pinning/`
- `603f6e1` → `.superpowers/sdd/2026-08-03-phase1b-wire-the-spine/task-9-report.md`

That evidence is unrecoverable by anyone, ever. If evidence is load-bearing, commit the evidence.
`D-207 (DEFERRED_REGISTER)` already ruled this for code comments; it applies to messages
identically.

**One dash style: the em dash (—).** The docs use it; 33 agentic commits use both it and `--` in
the same message.

## 5. Trailers

Blank line, then in this order:

```
Refs: D-165, D-168
ADR: 0001
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

**`Refs:`** — register row IDs, comma-separated. 144 commits reference rows in prose and none in a
trailer, so `git log --grep` is the only way to find them and it also catches passing mentions in
unrelated commits. A trailer is greppable, machine-readable, and it frees the subject.

**`ADR:`** — the ADR number(s) the change implements or revises (`docs/adr/`).

**`Co-authored-by:`** — exactly one line, and the model-versioned form the assistant's own harness
emits is accepted rather than fought: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.

Five variants are already in use (`Claude Opus 5` 117, `Claude Opus 5 (1M context)` 64,
`Claude Opus 4.8` 7, `Claude Sonnet 5` 3, `Claude Fable 5` 2), which splits
`git shortlog --group=trailer:co-authored-by` into five apparent contributors and will keep
growing with every model release.

**That fragmentation is a real cost, and this rule deliberately accepts it.** The alternative —
freezing one model-less string — was drafted first and rejected on a practical ground: each
assistant session is instructed by its own harness to write the versioned form, so a frozen
string would be violated by default on every commit, and a convention that must be violated to
be followed is not a convention. Normalise at read time instead, where it costs nothing:

```
git shortlog -s --group=trailer:co-authored-by | sed 's/Claude .*/Claude/'
```

Revisit if the harness ever emits a stable string. Do not add a second co-author line; one only.

## 6. Worked examples

All six are real commits here. Read them with `git log -1 --format='%s%n%b' <sha>`.

### Good

**`2b71e82`** — `fix(ci): env context not allowed in services.<id>.options` (57 chars, one file,
+7/−1). The body cites the failing push SHA, quotes the exact `actionlint` error text, states what
is explicitly *not* affected and why (`services.<id>.env` and `steps.env` are not subject to the
restriction — verified, not assumed), and closes "Verified locally before this push:
`actionlint .github/workflows/ci.yml` now exits 0." Every sentence is checkable from the repo.

**`696815c`** — `fix(1d-i): Playwright owns the server; CI serves the production build` (69 chars,
one file, +5/−1). Opens "Verified by reproduction, not inference", then gives two commands with
their exit behaviour and the citation `node_modules/playwright/lib/runner/index.js:821-827`. A
long body that is entirely evidence. Its one defect is the phase scope; it should be `fix(e2e)`.

**`260381e`** — `feat(tenancy): RLS policies, FORCE, and a DDL event trigger` (59 chars). Why
before what — "FORCE ROW LEVEL SECURITY closes the table-owner bypass — without it RLS is
decorative" — anchored to ADR-0001 control 4, and states what the migration deliberately excludes.
Under this convention it carries `Refs: D-062` and `ADR: 0001` instead of saying so in prose.

### Bad, with rewrites

**`6a47fbf`** — subject 83 chars; the body quotes a chat message verbatim into permanent history
("I read all four changes. The work is good, do not redo it") and narrates which agent did what.
The diff is one line in `docs/DEFERRED_REGISTER.md`.

```
docs(register): record a second way the review-lens rule goes unmet

D-197 (DEFERRED_REGISTER) recorded one failure mode for the
code-review/simplify obligation: a read-only reviewer declines to run a
fix-applying skill. The row now records a second and harder mode -- the
obligation treated as discharged by an unrelated approving remark,
leaving no trace unless the agent volunteers one.

The modes differ in detectability, which is why the row names them
separately: the first announces itself in a report, the second does not.
AGENTS.md §1 C4 requires an explicit verdict per lens for this reason.

Refs: D-197
```

**`e5bceee`** — subject 90 chars naming a session-management event as the reason for the commit
("…before compaction"); 57-line body opening "Asked whether it was safe to compact." The diff adds
`docs/planning/2026-08-14-collaboration-model-proposal.md` and one register row.

```
docs(plan): add the collaboration-model proposal and its evidence

The proposal turns reviewer and viewer from org roles into per-project
grants: assessor becomes member, invitees join view-only, and owners,
admins and project owners grant assessor or reviewer per project. One
person fills or reviews an assessment at a time; merging concurrent
edits is refused as out of scope.

The sequential-dependency argument rests on scoring, not visibility.
data/scoringConfig.json carries cross-stage weight rules under which an
area score in one stage changes the weights of named questions in a
later stage, so a merge would reconcile two scoring graphs rather than
two answer sets.

Two races reproduced against the development database. Completion versus
autosave is narrowed but open: lib/data/tenant.ts:209 opens the
transaction with no isolation level and the database runs READ
COMMITTED, so a concurrently committed write still lands between the
read and the write. Autosave versus autosave is a lost update --
respondToAssessment replaces the whole engineState blob without merging.
Neither is reached by a per-project lock, and nor is D-185
(DEFERRED_REGISTER), which is one user in two tabs and one lock holder.

lib/data/assessments.ts applies no userId filter (`grep -c userId
lib/data/assessments.ts` -> 0), so assessments are org-scoped rather
than creator-scoped: any owner, admin or assessor can edit any
assessment in the org, with no presence indicator in the UI.

Refs: D-210
ADR: 0002
```

**`413e23c`** — 145 characters, the longest subject in the repo; `(fix round 1)` anchors to
nothing; three unrelated fixes plus a register repair share one commit, so none can be reverted
alone. The fix is to split it, not to shorten the subject:

```
fix(authz): require member:revoke_owner to remove an owner
fix(api): return name only from lookupUserNames
fix(data): read and write assessments in one transaction
docs(register): replace two unchecked "no path exists" claims
```

Only the fourth carries `Refs: D-116, D-119` — the original folded that repair in as its point 4.
In full, the first of them:

```
fix(authz): require member:revoke_owner to remove an owner

member:remove is granted to both admin and owner and the only guard on
DELETE /api/orgs/[slug]/members/[userId] was the last-owner count, so an
org admin could remove an owner -- privilege escalation within the org.

The route's logic moves to lib/data/members.ts#removeMember, which
requires member:revoke_owner (owner-only) whenever the target is an
owner, composed with the existing last-owner guard rather than replacing
it. Covering tests in __tests__/integration/members.test.ts, each
verified non-vacuous by reverting the guard and watching it fail.
```

## 7. Commits, PR bodies, and the register

Three artifacts, three audiences. This convention does not delete session narrative; it relocates
it to where it was always supposed to live.

| Artifact | Explains | Audience | Contains |
|---|---|---|---|
| **Commit** | one diff | anyone running `git log` / `git blame` | why the change, evidence, machine-readable trailers |
| **PR body** | one branch | a person deciding whether to trust or revert | product-level framing, a verification table stating what was *not* verified, risk and reversibility, links to audit/plan/ADR |
| **`docs/DEFERRED_REGISTER.md`** | one decision not taken | a future session | why deferred, pick-up trigger, closure evidence |

**PR bodies here are already close to right** and need no redesign — all seven use headings,
tables, verbatim command output in fenced blocks, and explicit statements of what is not claimed.
Two fixes only. First, excise narrative inherited from commit messages: PR #4 has a section headed
"A regression test I destroyed" containing "My pre-deletion citation check counted **files**, not
occurrences", and PR #6 opens "Recorded before compaction" — both read as confessions rather than
as descriptions of a branch. Second, keep the Claude Code footer on all PRs or none; six of seven
carry it, PR #7 does not.

## 8. Scope of adoption

**Forward-only from 2026-08-18. History before that date predates this convention and is not
evidence that it was ignored.**

Nothing earlier is safe to rewrite, and that is not a preference:

- **There is nothing unpushed to amend.** `git log --branches --not --remotes --oneline` returns
  empty output and `gh pr list --state open` returns nothing — all seven PRs are `MERGED`. The
  boundary is exactly `HEAD`: only commits not yet written.
- **A rewrite would dangle citations in tracked documentation.** 37 distinct short SHAs in
  `docs/DEFERRED_REGISTER.md` alone resolve to real commits, with more in
  `docs/audits/2026-08-17-full-platform-audit-appendix.md`, the planning documents, and
  `docs/adr/0003-framework-version-registry-third-lane.md`. Register rows close by citing the
  commit that closed them; that chain is the project's own evidence trail.
- **Branch protection on `main` blocks it at the server.** A reading taken 2026-08-17 via
  `gh api repos/Alvin-Nahabwe/makai-rai-platform/branches/main/protection` recorded
  `allow_force_pushes.enabled=false` and `enforce_admins.enabled=true`. That call now returns HTTP
  403 ("Upgrade to GitHub Pro or make this repository public") because the repository is currently
  `PRIVATE` (`gh repo view --json visibility`), so the setting could not be re-confirmed on
  2026-08-18. The first two reasons stand without it.

A commit predating 2026-08-18 is judged by the rules in force when it was written, per
`AGENTS.md §7.3`.
