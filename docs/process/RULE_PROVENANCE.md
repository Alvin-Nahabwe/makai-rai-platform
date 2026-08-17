# Rule provenance — the evidence behind AGENTS.md

**Status:** reference document. Read at phase exits and when amending `AGENTS.md`; not required
reading to start a task.

---

## 1. What this document is

`AGENTS.md` is the operating ruleset for anyone — human or agent — doing engineering work on this
platform. Almost every rule in it was written in response to a specific failure, and until this
document existed the rule and the failure lived in the same paragraph.

The C4 code-review rule is representative. Stated as an instruction it is two lines: apply the
`code-review` lens, then the `simplify` lens, and give a separate verdict for each. In `AGENTS.md`
it occupied twenty (lines 91–110 before the split), because the other eighteen carry the audit that
produced it, a second incident that recurred inside the fix, and a three-way tool collision found
two phases later. All of that is worth keeping. None of it is what a contributor needs at the
moment work arrives for review.

This document is where that account now lives. `AGENTS.md` keeps the rule and its trigger. This
file keeps the incident, the date, the measurement, and the register row.

**Nothing here is new.** Every entry is evidence relocated out of `AGENTS.md`, quoted verbatim
wherever the original was narrative, plus the corresponding row from `docs/DEFERRED_REGISTER.md`
where one exists. Where a passage is quoted, the quote is exact — including its original
first-person voice, which is preserved rather than rewritten, because the specifics are the value.

### Why the split was made

Measured against the working tree on 2026-08-18, before any trimming:

| Property | Value | How measured |
|---|---|---|
| Length of `AGENTS.md` | 382 lines, 29,271 bytes | `wc -l -c AGENTS.md` → `382 29271 AGENTS.md` |
| Distinct register-row IDs cited | 12 | `grep -oE "D-[0-9]{3}" AGENTS.md \| sort -u \| wc -l` → `12` |
| Dated incident references | 15 | `grep -oE "2026-[0-9]{2}-[0-9]{2}" AGENTS.md \| wc -l` → `15` |
| Lines carrying a date or a register ID | 24 | `grep -cE '2026-[0-9]{2}-[0-9]{2}\|D-[0-9]{3}' AGENTS.md` → `24` |

The last figure understates the forensic content rather than measuring it: several of those 24 lines
are table rows over 1,500 characters long, and much of the narrative — the `proxy.ts` account in §3,
the `git add -A` account in §4, the three interaction defects — carries no date at all. The
investigation that proposed this split put the proportion at roughly 30% conventions to 70% dated
incident forensics; that estimate is recorded here as an estimate, not re-measured.

Either way the proportion is a problem for two different readers at once. A contributor arriving to
do a task has to separate the instruction from the anecdote. An institution evaluating this
platform — the intended audience for a governance product — reads the front-door engineering
document as an internal post-mortem log rather than a set of engineering conventions.

Splitting by audience fixes both without discarding anything: the trigger table binds day-to-day
work, and the evidence stays available, complete, at a stable address.

---

## 2. How it relates to AGENTS.md

`AGENTS.md` is organised by **moment** — six checkpoints (C1 task start, C2 before dispatch,
C3 mid-execution, C4 on receiving work, C5 before claiming done, C6 phase exit) plus sections §0–§7.
This document mirrors that organisation exactly: one section here per section there, entries in the
order the rules appear.

To trace a rule to its evidence: note the section the rule sits in (`§4 — Delegation`, say), open
the matching section here, and find the entry whose **Rule it justifies** line quotes it. The
index in section 4 below gives the same route starting from a register-row ID or a date.

**Citations here name sections, not line numbers, for `AGENTS.md`.** `AGENTS.md` is edited often
and line numbers in it go stale within a commit or two. Line numbers *are* given for
`docs/DEFERRED_REGISTER.md` rows, since that file is 500KB and a row is hard to find without one —
but those numbers were correct on 2026-08-18 and the row ID (`D-063`) is the durable identifier.

### Why this file is deliberately not loaded into every agent session

`AGENTS.md` is loaded into every agent session: `CLAUDE.md` contains exactly one line, `@AGENTS.md`
(`cat CLAUDE.md` → `@AGENTS.md`). This file is not included there, and that is a design decision
rather than an oversight.

The reasoning is `AGENTS.md`'s own §0 finding: an obligation fires because something observable
triggers it, not because it was read recently. This file is roughly 70KB (`wc -c
docs/process/RULE_PROVENANCE.md`), more than twice the size of the ruleset it explains. Loading it
into every session would spend that budget on history in a context window that has to hold the
actual task, and it would buy nothing at the moment a rule needs to fire — at that moment the
reader needs the trigger and the action, which is what the trimmed `AGENTS.md` provides.

The provenance is for the two moments where history is the thing you need:

1. **Phase exit.** `AGENTS.md` §0.3 already requires re-reading `AGENTS.md` end to end at every
   phase exit ("*Re-read this document end to end at every phase exit*"). That is the natural
   moment to read this file too, because that is when someone is deciding whether a rule is
   still earning its place, and a rule cannot be judged without knowing what it cost to learn.
2. **Amendment.** `AGENTS.md` §0.2 requires checking whether an existing principle already covers
   a proposed addition — the previous ruleset accumulated three separate statements of one idea
   because each new instance was patched locally. Checking that properly means reading what the
   existing rules were built from, which is here.

---

## 3. How to read an entry

Each entry has the same fields:

- **Rule it justifies** — the obligation in `AGENTS.md`, quoted or named, with its section.
- **Date** — when the incident happened, or when the amendment was made. Both, where they differ.
- **Register row** — the `docs/DEFERRED_REGISTER.md` row ID, its recorded type and open date, and
  its line number as of 2026-08-18. Absent where the incident never produced a row.
- **What happened** — the account. Quoted verbatim from `AGENTS.md` where `AGENTS.md` was
  narrative; supplemented from the register row where the row carries detail `AGENTS.md` compressed.
- **What changed** — the amendment the incident produced.
- **Verified since** — present only where the current state of the repository was checked while
  writing this file, with the command or the file:line.

A rule in `AGENTS.md` with no entry here carries no incident: it is a convention, a definition, or
a derivation from another rule. Section 13 lists those explicitly, so that a missing entry reads as
"nothing to find" rather than "provenance lost".

---

## 4. Index

### 4.1 By register row

Rows are in `docs/DEFERRED_REGISTER.md`; line numbers as of 2026-08-18.

Entry numbers below are plain section numbers in this document, not links — they survive editing,
which anchors do not.

| Row | Line | Type | Opened | Subject | Rule it produced | Entry |
|---|---|---|---|---|---|---|
| D-063 | 109 | PROCESS FAILURE | 2026-08-02 | Phase-1a Tasks 1–5 built with the mandated skill process bypassed, and the bypass not disclosed | C1 "a process/orchestration skill never discharges the always-on tier"; §6 same-commit register rows | 5.2, 9.2, 11.1 |
| D-068 | 114 | PROCESS FAILURE | 2026-08-02 | A register row used to launder an unexamined problem, which the process audit would have passed | §6 "a register row is not a substitute for trying"; §5 investigate-before-characterising | 10.2, 11.2 |
| D-083 | 129 | PROCESS FAILURE | 2026-08-03 | `code-review` and `simplify` invoked **zero** times across the whole Plan 1a redo | C4 code-review-then-simplify lenses; C6 mechanical skill re-audit | 6.1, 6.5 |
| D-084 | 130 | PROCESS FAILURE | 2026-08-03 | `superpowers:systematic-debugging` never invoked, through four real debugging episodes | §2 row: about to work around something that failed | 7.1, 6.3 |
| D-085 | 131 | RISK | 2026-08-03 | The most on-point tool in the inventory for Plan 1a's actual defects was never used | §2 row: about to write error handling, a fallback, a `catch`, a default | 7.2 |
| D-092 | 138 | PROCESS FAILURE | 2026-08-03 | Guards repeatedly closed the bypass shapes their author enumerated and left the class open — four times | §2 row: adversarial review of a finished design artifact | 7.4 |
| D-099 | 145 | RISK | 2026-08-03 | Per-request identity reads concentrate load on the owner connection, and the obvious fix re-opens D-075 | §3 decomposition step 5 (`what-if-oracle` on the decomposition itself) | 8.8 |
| D-103 | 149 | PROCESS FAILURE | 2026-08-03 | Design-time completeness has no checkpoint: three defects in one session, all inside enumerations | §3 decomposition obligation; §2 enumeration trigger | 8.4, 7.3, 7.4 |
| D-136 | 185 | PROCESS FAILURE | 2026-08-05 | The planning stage has no execution step; every controller-introduced Plan 1b defect was an unexecuted claim about behaviour | §2 row: about to hand over a plan or a task brief | 7.5 |
| D-143 | 192 | BUG | 2026-08-07 | A route broken by Task 1's NOT NULL constraint, with no task in the 12-task plan fixing it | §2 hand-over check (2) — pair reads and writes | 7.5 |
| D-191 | 240 | PROCESS FAILURE | 2026-08-10 | An obligation names a PROPERTY while its implementation and test name a MECHANISM — eight instances in one phase | §2 row: about to record an obligation as discharged | 7.6 |
| D-197 | 246 | PROCESS FAILURE | 2026-08-10 | C4's `code-review`/`simplify` instruction collides three ways with SDD and read-only review dispatches | C4 "the lens is the obligation; the tool is one way of carrying it" | 6.2 |

### 4.2 By date

| Date | What happened | Entries |
|---|---|---|
| 2026-08-02 | Plan 1a Tasks 1–5 rolled back: process bypassed, undisclosed. Untracked probe files and an uncommitted isolation test found in the tree. A blocked skill laundered into a register row. | 5.2, 9.2, 10.2, 11.1, 11.2 |
| 2026-08-03 | Plan 1a exit. Failures classified against the rules that should have caught them; the skill audit run mechanically; `AGENTS.md` restructured around checkpoints. Nine of the fifteen dated references in `AGENTS.md` are from this day. | 5.1, 5.3, 5.4, 6.1, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 8.4, 8.5, 8.6, 8.8, 8.10, 9.3 |
| 2026-08-05 | Plan 1b exit. C6 `security-review` found two controls whose enforcement point moved while their trigger stayed behind. D-136 opened. | 8.2, 7.5 |
| 2026-08-07 | D-143 opened: a route broken by an earlier task's schema change, with no plan task fixing it. | 7.5 |
| 2026-08-10 | Plan 1c close. D-136 ruled installed. D-191 and D-197 opened. Two subagent stalls traced to dispatches that let a helper be awaited. | 7.5, 7.6, 6.2, 9.1 |
| 2026-08-12 | Phase 1d-i exit. C4 amended on the human partner's ruling: the lens is the obligation, the tool is one way of carrying it. | 6.2 |

---

## 5. §0 — How to use this document

### 5.1 The classification that produced the checkpoint structure

**Rule it justifies** — the entire organisation of `AGENTS.md` by moment rather than by topic, and
its stated design constraint: "*An obligation that names no observable trigger will not fire.
Adding emphasis does not change this.*"

**Date** — 2026-08-03.

**Register row** — none directly; the classification drew on D-063, D-068, D-083, D-084, D-085.

**What happened** — verbatim from `AGENTS.md` §0:

> On 2026-08-03 the failures on this project were classified against the rules that should have
> caught them. The result was unambiguous: **every rule bound to a mechanical event held; every
> rule that depended on remembering an obligation at the right moment failed.**
> `git status --untracked-files=all` fired every time. The same-commit register requirement fired
> every time (git makes the omission visible). The `UserPromptSubmit` hook fired every turn.
> Meanwhile "verify, do not transcribe", "design systems not components" and "triggers are not only
> task-start" fired **zero** times unprompted, despite being written down for days.

**What changed** — the ruleset was rewritten from a numbered list of principles into six
checkpoints plus a mid-execution trigger table, and §0.1 was added: an amendment that binds to no
checkpoint is rejected.

**Standing caveat, recorded 2026-08-17.** One of the three mechanisms named above as having held —
the `UserPromptSubmit` hook — does not ship with the repository. The 2026-08-17 platform audit
records this as finding DOC-12 (`docs/audits/2026-08-17-full-platform-audit-appendix.md:1289–1298`):
`git ls-files .claude/` returns empty, and `.claude/settings.local.json` is untracked with no
`hooks` key and no `UserPromptSubmit` anywhere. The hook fired in the sessions the classification
measured, on the machine those sessions ran on; it is not enforcement anyone else inherits by
cloning. The classification's finding is unaffected — the two other mechanisms are in-repo — but
the hook should be read as a per-machine setup, not as a property of the codebase.

### 5.2 Orchestration substitution — the 2026-08-02 rollback

**Rule it justifies** — `AGENTS.md` §1 C1: "*A process/orchestration skill never discharges the
always-on tier.*" Symptom named there to catch it: "*the review loop already covers this.*"

**Date** — 2026-08-02 (incident and rollback); rules amended in the same commit.

**Register row** — D-063, PROCESS FAILURE, opened 2026-08-02
(`docs/DEFERRED_REGISTER.md:109`), titled "Phase-1a Tasks 1–5 were built with the mandated skill
process bypassed, and the bypass was not disclosed". Closed at the Plan 1a exit, 2026-08-03.

**What happened** — `AGENTS.md` compresses it to one sentence:

> This exact substitution caused the 2026-08-02 rollback (D-063) — five tasks of tenancy work with
> no `database-design:postgresql` and no `security-review`.

The register row gives the full account. Schema, tenant port, RBAC, data-access layer and RLS were
all implemented without `database-designer` / `database-design:postgresql`, without
`senior-security` / `security-review`, without TDD, and without `verification-before-completion` —
none invoked. Two mechanisms caused it:

1. Invoking `superpowers:subagent-driven-development` made its internal review loop *feel* like the
   process, though it checks a diff against a brief after the fact and supplies no domain expertise.
2. Deferring a skill cost nothing and left no trace, because the rule then in force governed
   deferred *work* but not deferred *process* — `security-review` was rescheduled into a
   session-local todo and evaporated.

Compounding both: subagents were dispatched with briefs but no obligation to follow the process
themselves, and left untracked files that no review package could ever see (see entry 9.2).
The failure was surfaced by the human partner, not self-reported.

**What changed** — the implementation was discarded and the branch rolled back to `9739454`
(process artifacts and spike evidence retained; ADR-0001 and ADR-0002 held back for re-derivation
with domain skills). Three rules were amended and one added, in the same commit. Those amendments
survive today as §1 C1 plus the §2 trigger table, §6 including its "not a substitute for trying"
clause, and §4 delegation.

### 5.3 Rules 6, 8 and 10 — one idea written three times

**Rule it justifies** — `AGENTS.md` §0.2: "*Before adding anything, check whether an existing
principle already covers it.*"

**Date** — not recorded beyond "three separate days" before the 2026-08-03 restructure.

**What happened** — verbatim from `AGENTS.md` §0.2:

> Rules 6, 8 and 10 of the previous version were three statements of one idea, added on three
> separate days because each new instance was patched locally instead of recognised.

Those three are the ones now merged into §5 — inherited claims, self-generated obstacle claims, and
inability claims — as `AGENTS.md` §5 itself notes in its opening parenthesis.

**What changed** — §0.2 and the merge into a single §5.

### 5.4 The ruleset nobody had read whole

**Rule it justifies** — `AGENTS.md` §0.3: "*Re-read this document end to end at every phase exit.*"

**Date** — before 2026-08-03.

**What happened** — verbatim from `AGENTS.md` §0.3:

> The previous version reached ten rules and 182 lines without anyone — including the agent editing
> it — having read it whole.

**What changed** — the phase-exit re-read obligation, now also listed as a C6 item.

---

## 6. §1 — Checkpoints

The C1 rule against orchestration substitution is covered by entry 5.2, since the same incident
drives §0 as well. This section covers the remaining checkpoint rules.

### 6.1 The code-review and simplify lenses

**Rule it justifies** — `AGENTS.md` §1 C4: "*Apply the `code-review` and `simplify` LENSES to the
chunk — code-review first, then simplify on what you are keeping.*"

**Date** — 2026-08-03, at the Plan 1a exit.

**Register row** — D-083, PROCESS FAILURE, opened 2026-08-03
(`docs/DEFERRED_REGISTER.md:129`), titled "`code-review` and `code-simplifier`/`simplify` were
invoked **zero** times across the whole Plan 1a redo, though both are Tier 1 always-on". Closed
2026-08-03.

**What happened** — verbatim from `AGENTS.md` C4:

> Added 2026-08-03 after the Plan 1a exit audit measured **zero** invocations of either across the
> entire redo; neither skill was named in any checkpoint, which is why nothing caught it (D-083).

The register row records how it was measured and what the measurement showed: a grep of the SDD
ledger and all **28 branch commits** returned 0 occurrences of either skill. It also records the
structural finding that generalises beyond these two skills:

> the audit found that **8 of 8 skills named in an AGENTS.md checkpoint or the `UserPromptSubmit`
> hook fired, and 0 of 6 named only in SKILLS_INVENTORY.md "Tier 1" did** — `code-review` was in
> neither.

The row also names the recurrence: this is "the **same mechanism as D-063 recurring inside the redo
built to prevent it**" — the `subagent-driven-development` review loop felt like code review, but it
checks a diff against a brief after the fact.

**What changed** — C4 names both skills explicitly, and `docs/SKILLS_INVENTORY.md` was restructured
by moment (v0.2) with a maintenance rule that an inventory entry absent from `AGENTS.md` is
decorative. `AGENTS.md` C4 additionally spells out what does *not* discharge the lenses: a
spec-compliance verdict, because "*a reviewer answering 'does this diff match its brief?' has not
reviewed correctness or clarity, and counting it as though it had is the orchestration substitution
named in C1 — it caused D-063 and recurred in the redo built to prevent it*".

### 6.2 The three-way collision that made C4 unsatisfiable

**Rule it justifies** — `AGENTS.md` §1 C4, the "what does discharge them" paragraph, and its
closing line: "*The lens is the obligation; the tool is one way of carrying it.*"

**Date** — row opened 2026-08-10 (Phase 1d-i, Tasks 1 and 3); amendment made 2026-08-12 at the
Phase 1d-i exit, on the human partner's ruling.

**Register row** — D-197, PROCESS FAILURE, opened 2026-08-10
(`docs/DEFERRED_REGISTER.md:246`), titled: "AGENTS.md C4 tells the controller to run `code-review`
then `simplify` on every chunk, but both are FIX-APPLYING skills — so honouring C4 literally makes
the controller apply fixes, which `subagent-driven-development` explicitly forbids, and delegating
them to a reviewer collides with the read-only instruction every review dispatch carries".

**What happened** — verbatim from `AGENTS.md` C4:

> Amended 2026-08-12 at the Phase 1d-i exit, on the human partner's ruling, because the original
> wording was unsatisfiable in this project's actual workflow and D-197 recorded it failing three
> times in one phase by three agents for three different reasons. Both skills' documented mode is
> review-**and-apply-fixes**; `subagent-driven-development` forbids the controller from fixing
> findings itself (its fixes skip review); and a review subagent is dispatched read-only so it
> cannot race the implementer for the working tree. Any two of those hold together. All three
> cannot.

The register row records the two instances it captured directly:

- **First instance (Task 1 reviewer, Phase 1d-i).** The reviewer declined to invoke either skill
  mechanically and said why: the skills' own descriptions state they review *and then apply the
  fixes*, and both may run as autonomous subagents with write tools, contradicting the dispatch's
  explicit "do not modify any repo file, read-and-report only". Faced with two incompatible
  instructions it chose the more specific one, applied both lenses by direct manual analysis with
  commands and outputs cited, produced a real Important finding plus an explicit non-manufactured
  "simplify: Clean" verdict, and flagged that it could not open the register row itself under
  read-only scope.
- **Second instance (Task 3 implementer, 2026-08-10).** The implementer attempted to invoke the
  skills and reported the tool call was rejected mid-session; it then treated the controller's
  interruption message — "I read all four changes. The work is good, do not redo it" — as
  substituting for the checkpoint, and said so in its report rather than skipping silently. The
  row separates the two halves: the honesty is the process working; the substitution is not,
  because the controller reading a diff is not the mechanical form C4 specified, and that sentence
  existed to stop an agent redoing sound work after an interruption, not to discharge a checkpoint.

The row also names the root cause in the project's own vocabulary: "C4 was written before this
project adopted SDD, and the two documents were never reconciled — the same shape AGENTS.md §3
names, a rule whose enforcement point moved while its trigger stayed behind."

**What changed** — C4 now states that the discharge requires a separate, explicit verdict per lens,
and that either the controller invoking the skills directly *or* a dispatched reviewer applying
both lenses by direct analysis satisfies it.

### 6.3 One browser launcher failing is not "no browser"

**Rule it justifies** — `AGENTS.md` §1 C5: "*If one browser launcher fails, try another before
concluding none is available.*"

**Date** — 2026-08-03.

**Register row** — none of its own; the same episode is one of the four listed in D-084 (see 7.1).

**What happened** — verbatim from `AGENTS.md` C5:

> on 2026-08-03 Playwright's Chrome died on a Qt platform-plugin error while the chrome-devtools
> MCP worked fine.

**What changed** — the C5 clause above, inside the "live end-to-end verification is the definition
of done" rule.

### 6.4 Moving security-review from C4 to C6, on a measurement

**Rule it justifies** — `AGENTS.md` §1 C6: "*Run `security-review` over the whole branch diff*",
and the §7.1 split between a preventive per-task pass and a detective per-branch scan.

**Date** — amendment 2026-08-03, with the human partner's approval.

**What happened** — verbatim from `AGENTS.md` C6:

> This is its natural granularity: the skill resolves `git diff origin/HEAD...`, so it re-reads the
> entire branch on every invocation. Run per-task it re-reviews already-reviewed code at compounding
> cost (205KB by Task 3) while adding little — the per-task security work that actually finds things
> is the *preventive* pass (§7.1). Moved here from C4 by amendment on 2026-08-03, with the human
> partner's approval, after measuring the cost rather than assuming it.

The last clause is the point of the entry as much as the measurement is: the move was made on a
measured 205KB re-read by Task 3, not on an assumed cost. `AGENTS.md` §5 forbids asserting a cost
that has not been scoped, and this is the amendment that honoured it.

**What changed** — `security-review` moved from a per-task obligation to a branch-granularity C6
obligation, with `senior-security` retained per-task as the preventive half.

### 6.5 The skill audit that found the gap, and the recollection that would not have

**Rule it justifies** — `AGENTS.md` §1 C6: "*Re-audit skill invocation mechanically, the way the
Plan 1a exit did it.*"

**Date** — 2026-08-03.

**Register row** — D-083 (see 6.1) is the finding that audit produced.

**What happened** — verbatim from `AGENTS.md` C6:

> grep the SDD ledger and the branch commits for every skill named in `docs/SKILLS_INVENTORY.md`,
> and compare the ones bound to a checkpoint against the ones that are not. That audit is what found
> the `code-review` gap; asking "did we follow the process?" from memory did not, and would not.

**What changed** — the mechanical re-audit became a standing C6 item rather than a one-off.

---

## 7. §2 — Mid-execution triggers

### 7.1 Four debugging episodes, no debugging skill

**Rule it justifies** — `AGENTS.md` §2, row "*You are about to work around something that failed*"
→ invoke `superpowers:systematic-debugging`.

**Date** — 2026-08-03.

**Register row** — D-084, PROCESS FAILURE, opened 2026-08-03
(`docs/DEFERRED_REGISTER.md:130`), titled "`superpowers:systematic-debugging` never invoked, through
four real debugging episodes".

**What happened** — verbatim from `AGENTS.md` §2:

> The skill is named here as of 2026-08-03: this row already said "investigate" but named no skill,
> and the skill was invoked **zero** times across Plan 1a despite four real debugging episodes
> (D-084).

The register row names all four, and they are worth having in full because each one is a shape that
recurs:

1. FATAL Turbopack panics — root-caused to a stale `.next` from a failed build.
2. Playwright's Chrome dying on a Qt platform-plugin error (the same episode behind entry 6.3).
3. `npm run seed` failing as a missing script — it lives under `package.json`'s `prisma` key.
4. A subagent's psql `-c` syntax error — psql's `-c` rejects client-side `\gset`-style variables.

The row also records *why* the skill did not fire, which is the transferable part: the SDD ledger
contains exactly one mention of it, at Task 0, and that mention is a *declination* with a valid
reason at the time ("no probe behaved unexpectedly"). It was never reconsidered when the trigger
actually fired. All four episodes were investigated to root cause and none was papered over — but
the row explicitly refuses to defend the decision by its outcome, citing §7.3: "the debugging was ad
hoc, not skill-guided, and a once-made declination silently aged, which is the §2 'reusing a
previously-derived conclusion' trap."

**What changed** — the §2 row now names the skill instead of saying "investigate".

### 7.2 The fail-open defects, and the tool aimed at them

**Rule it justifies** — `AGENTS.md` §2, row "*You are about to write error handling, a fallback, a
`catch`, or a default value*" → dispatch `pr-review-toolkit:silent-failure-hunter` (an agent, not a
skill).

**Date** — 2026-08-03.

**Register row** — D-085, RISK, opened 2026-08-03 (`docs/DEFERRED_REGISTER.md:131`), titled "The
most on-point tool in the inventory for Plan 1a's actual defects was never used". Closed 2026-08-03.

**What happened** — verbatim from `AGENTS.md` §2:

> Both fail-open defects Plan 1a shipped were silent fallbacks on a path that bypassed RLS, and this
> is the one tool aimed exactly at them — never used (D-085).

The register row identifies the two defects by row: **D-080** (Prisma `undefined` filter-elision)
and **D-081** (`identityDb` relation traversal), both silent fail-opens on a path that bypasses RLS.
It records two compounding causes rather than one:

1. The tool was bound to no moment.
2. Version 0.1 of `docs/SKILLS_INVENTORY.md` **listed `silent-failure-hunter` among skills when it
   is an Agent** (`subagent_type`) — so "invoke the skill" would have failed even if someone had
   tried.

The row also names two further zero-invocation tools from the same audit:
`engineering-skills:adversarial-reviewer`, and `engineering-advanced-skills:env-secrets-manager`
during Task 4's credential and provisioning work, "where a committed migration would have published
a production password".

Closure note on the row: "**CLOSED 2026-08-03 — dispatched, and it earned the row.**"

**What changed** — §2 binds the agent to the observable moment of writing a fallback, and
`SKILLS_INVENTORY.md` §4 now separates skills from agents from MCP tools.

### 7.3 An enumeration that feels thorough

**Rule it justifies** — `AGENTS.md` §2, row "*You have just produced an enumeration that will be
treated as complete*" → run §3's decomposition obligation.

**Date** — 2026-08-03.

**Register row** — D-103 (see 8.4).

**What happened** — verbatim from `AGENTS.md` §2:

> Do **not** skip it because the list feels thorough — that feeling is the failure mode, not a
> reason to trust it (D-103).

D-103 states the mechanism precisely: "attending to N correct elements generates a completion signal
proportional to N that substitutes for the completeness question."

**What changed** — the enumeration trigger was added to §2 so the §3 obligation has an observable
moment to fire at, rather than depending on someone recognising that they have just decomposed
something.

### 7.4 Self-review is 0-for-7; independent review is 7-for-7

**Rule it justifies** — `AGENTS.md` §2, row "*You have finished a design artifact… and are about to
put it in front of your human partner*" → `engineering-skills:adversarial-reviewer`, briefed to
attack the decomposition rather than the content.

**Date** — 2026-08-03.

**Register rows** — D-092, PROCESS FAILURE, opened 2026-08-03 (`docs/DEFERRED_REGISTER.md:138`),
and D-103, PROCESS FAILURE, opened 2026-08-03 (`docs/DEFERRED_REGISTER.md:149`).

**What happened** — verbatim from `AGENTS.md` §2:

> Self-review is **0-for-7** on this class; independent review is 7-for-7 (D-092, D-103).

The seven are the two rows added together — four from D-092, three from D-103.

**D-092's four**, all guards that closed the bypass shapes their author enumerated and left the
class open, and three of which were fixes for the previous one:

1. The ESLint ban caught `@/lib/db`, `../../lib/db` and `./db` and missed `../../db`; after
   widening it still missed `await import()` and `require()`, because `no-restricted-imports` sees
   only static declarations.
2. The DDL-trigger pin caught the trigger's existence and all three command tags and missed
   `evtenabled`, so `ALTER EVENT TRIGGER … DISABLE` passed it.
3. `assertNoTenantRelation` v1 checked five named clauses at depth 1 and missed nesting, `where`
   combinators, `_count`, array `orderBy` and `upsert`.
4. The Proxy that replaced the type-only narrowing was escaped via `user.$parent` and symbol keys,
   and the recursive walk still missed `_count: true`.

D-092's own summary of the pattern: "**In every case a test pinned exactly the shapes the author had
thought of and passed.**" And the measurement that produced the 0-for-7 half: "**an independent
reviewer found all four; the author's own re-reading found none of them**."

**D-103's three**, all inside enumerations, all in one design session:

1. An exhaustive proof-obligation list and an exhaustive route port, with nothing asking whether the
   RBAC matrix connects to the routes — so `can()` could be perfect while every route consulted the
   wrong action.
2. A 20-file inventory built from one lens ("imports `prisma`") that missed 8 pages, including
   project creation.
3. A definition-of-done gate claiming that an invitation into the *same* org demonstrated *two-org
   isolation*.

D-092 also records what actually worked in place of interception guards, which is the constructive
half of the same lesson: "building the surface by construction (nothing to escape through), deriving
the denied set from generated types (`keyof Prisma.UserInclude`) so the compiler maintains it, and
asserting a control's *behaviour* rather than its *presence*".

**What changed** — §2 binds `adversarial-reviewer` to the moment a design artifact is finished, with
the brief pointed at the decomposition ("what is missing, and what lens would reveal it?") rather
than at the content. D-092 remains open as a standing process trigger at the C1 of any task that
writes a guard, re-targeted 2026-08-05 at the Plan 1b register reconciliation because it is not
phase-bound. Its own prediction proved out: commit `6cffe94` (Task 12, fix round 2) describes itself
as "guard number six in this project's D-092 pattern".

### 7.5 Plans that asserted behaviour nobody ran

**Rule it justifies** — `AGENTS.md` §2, row "*You are about to hand over a plan or a task brief*",
with its two mechanical checks: **(1) execute the claims**, **(2) pair reads and writes**.

**Dates** — incident 2026-08-05 (Plan 1b close, row opened); ruling and installation 2026-08-10
after Plan 1c. `AGENTS.md` records the installation date; the register records the opening date.
Both are correct and they are not the same event: the row was deliberately held open as a *proposal*
because, in its own words, "installing my own process fix for my own failure pattern, while
asserting it closes that pattern, is the move that needs a second opinion."

**Register rows** — D-136, PROCESS FAILURE, opened 2026-08-05
(`docs/DEFERRED_REGISTER.md:185`), titled "The planning stage has no execution step, and every
defect the controller introduced in Plan 1b was an unexecuted claim about behaviour". Closed-done
2026-08-10. And D-143, BUG, opened 2026-08-07 (`docs/DEFERRED_REGISTER.md:192`).

**What happened** — `AGENTS.md` §2 lists what the two checks would have caught, verbatim:

> The record either check would have caught: `engineState.version` asserted as the framework version
> when it is the engine's; a slug-retry that could not work because Postgres aborts a transaction on
> any statement error; two `no-restricted-imports` blocks assumed to merge when flat config
> replaces; a non-vacuity instruction naming two actions with identical grants; and, three separate
> times, a file list built from the *readers* of a value with no entry for the file that writes it
> (D-143, and twice more in the same phase).

D-136's own list of the Plan 1b originals overlaps with but is not identical to that list, and both
are worth keeping:

1. ADR-0002 asserted the absolute session cap could be enforced against the JWT `iat` — and
   `@auth/core` resets `iat` on every re-encode.
2. The plan's slug-collision retry could not work, because Postgres aborts a transaction on any
   statement error and a retry needs `SAVEPOINT`.
3. The ESLint config was assumed to merge two `no-restricted-imports` blocks — flat config
   *replaces* rule options, so the import bans did not exist at all.
4. A non-vacuity instruction told an implementer to swap two actions that turned out to have
   identical grant sets, so nothing would have gone red.
5. `lastActiveOrgId` was read by one task and written by none — not a false claim, but an unpaired
   one.

The row is explicit that each of the first four "was seconds to verify — one `node -e`, one psql
query, one `--print-config`, one grep — and none was verified", and it states the structural reason:

> implementers hit reality constantly because code either runs or does not; planners never do unless
> something forces it. So plan-stage defects are systematically of the unexecutable-claim kind, and
> are systematically invisible to every review instrument the controller owns — STRIDE,
> `what-if-oracle` and `adversarial-reviewer` are all reading instruments pointed at a
> reading-shaped artifact.

**D-143** is the read/write-pairing instance `AGENTS.md` cites by ID: `POST
/api/v1/orgs/[slug]/assessments` (`app/api/v1/orgs/[slug]/assessments/route.ts:68`) was broken by
Task 1's `frameworkVersionId` NOT NULL constraint, and no task in the 12-task Plan 1c plan fixed it.

**The honest limit, recorded with the fix rather than after it** — D-136 states that neither check
touches *judgment* errors: "The representative-versus-exhaustive live-matrix call was wrong and was
not an unexecuted claim; the only instrument with a record against that class is an independent
reviewer who disagrees, and in that instance it was the human partner."

**The falsifiable test the row attached to itself, which still stands** — "if a later phase's C6
finds a controller-introduced defect that IS an unexecuted behavioural claim, the checks are not
firing and must be reconsidered rather than reworded."

**What changed** — both checks became one §2 trigger row bound to the moment a plan or brief is
handed over, since they fire at the same moment.

### 7.6 Eight obligations discharged by tests that proved something else

**Rule it justifies** — `AGENTS.md` §2, row "*You are about to record an obligation as
discharged*" → state the property, state what the test causes, ask whether the second entails the
first.

**Date** — 2026-08-10, after Plan 1c.

**Register row** — D-191, PROCESS FAILURE, opened 2026-08-10
(`docs/DEFERRED_REGISTER.md:240`), titled "An obligation names a PROPERTY while its implementation
and test name a MECHANISM, and nothing checks the two refer to the same thing — eight instances in
one phase".

**What happened** — verbatim from `AGENTS.md` §2:

> Installed 2026-08-10 after Plan 1c (D-191), where this class produced **eight** defects that each
> passed their own tests: "stop accepting answers" implemented as "block evidence uploads", then as
> "block the PATCH" while completion had no check; "reject oversized" tested with a fixture the
> *no-signature* branch rejected; "honours whichever committed" testing only the rollback direction;
> a PDF stamping a pinned hash on content it had not used; an obligation recorded as met that the
> grant model made unimplementable.

The register row enumerates all eight with their locations in the phase:

1. Task 5's size fixture was rejected by the no-signature fallthrough, not the size guard — so
   deleting the guard left the suite green.
2. Task 7's concurrency test proved the ROLLBACK direction while its docstring claimed both,
   leaving untested the direction where evidence silently vanishes.
3. O-14's in-progress half was implemented on the evidence-upload route — and uploading an artifact
   is not answering a question.
4. Then again on `respondToAssessment`, while `completeAssessment` — the path that permanently bakes
   a score into an immutable record — had no check at all.
5. The PDF route stamped a pinned hash on content it had not used, with the banner suppressed by
   construction for exactly that case.
6. O-24's second clause was recorded as satisfied while the grant model made it unimplementable.
7. The drift banner asserted the report is not recalculated, while the largest section recalculates
   on every view.
8. Creation could mint an assessment that can never be answered.

**Why this is a reading obligation and not another test** — verbatim from `AGENTS.md`:

> **`trigger-enumeration.test.ts` cannot catch this class** — it greps for mechanisms, so a guard on
> the wrong surface satisfies it exactly.

D-191 records the same conclusion in the C6 whole-branch reviewer's words: "a grep-for-the-mechanism
test cannot verify a property-to-mechanism translation, by construction."

**What changed** — the §2 discharge-check row, bound to the moment of recording an obligation as
met in a report, a commit message, a coverage map, or a register closure.

---

## 8. §3 — Design and change

### 8.1 The interaction defects behind "state what it interacts with"

**Rule it justifies** — `AGENTS.md` §3, "Designing something new": state the unit's single
responsibility and "*how does it interact with every layer it touches, including the ones it does
not call directly*".

**Date** — not individually dated in `AGENTS.md`; all from Phase 1 work.

**What happened** — verbatim from `AGENTS.md` §3:

> Most defects here have been *interaction* defects: rate limiting worked but its in-memory store
> broke under multi-instance hosting; logout worked but a JWT decision elsewhere made it
> unrevocable; `orgDb` was specified as "inject orgId **and** enforce role **and** set the GUC",
> which is why it was ambiguous whether it filtered at all. Components verified in isolation compose
> into a broken system.

**Verified since** — the rate-limiting instance is still live in the codebase, not merely
historical: the 2026-08-17 audit records `lib/rate-limit.ts:73` (`const store = new Map<string,
RateLimitEntry>();`) and the `setInterval` cleanup at `:76-85`, with no shared or Redis backend
(`docs/audits/2026-08-17-full-platform-audit-appendix.md:365`).

### 8.2 The control whose enforcement point moved

**Rule it justifies** — `AGENTS.md` §3, the fourth reach question: "*What now happens on the paths I
did not touch?*" — and the mechanism that now backs it,
`__tests__/integration/trigger-enumeration.test.ts`.

**Date** — 2026-08-05, at the Plan 1b exit.

**Register row** — none; found by that phase's C6 `security-review` and fixed within the phase.

**What happened** — verbatim from `AGENTS.md` §3:

> Added 2026-08-05 at the Plan 1b exit. That phase's C6 `security-review` found two defects of one
> shape: Task 4 removed `mustChangePassword` from the JWT — correct, ADR-backed, cleanly reviewed —
> and `proxy.ts` went on reading it, type-checking fine because `next-auth/jwt`'s `JWT` is
> index-signature-open, and silently evaluating to `undefined` on every request. The same task
> shipped `bumpSessionEpoch` with **no production caller at all**. Both are *"a control whose
> enforcement point moved while its trigger stayed behind."* 1080 unit tests, a 726-cell permission
> matrix and a 57-test live browser walk all passed over both.

And on why no diff-scoped review could have caught it:

> Neither is visible in any single task's diff — `proxy.ts` is not in Task 4's diff, and a
> function's definition always looks complete. **So no diff-scoped review of any kind can catch this
> class**: not `code-review`, not the task reviewer, not an adversarial pass on the same diff. Only
> whole-tree analysis can, which is why C6 runs at branch granularity.

**What changed** — `__tests__/integration/trigger-enumeration.test.ts` was written to enumerate,
from disk, the production callers of guards that must be wired and the read-sites of columns that
gate behaviour, failing when one has none. `AGENTS.md` §3 states the distinction that makes it a
different test from the two that already existed: "*`port-completeness` and `preauth-surface` already
enumerate *surfaces*; this enumerates *triggers*, and the gap between those two words is where both
defects lived.*"

**Verified since** — all three suites exist
(`__tests__/integration/trigger-enumeration.test.ts`, `port-completeness.test.ts`,
`preauth-surface.test.ts`), and the trigger suite's own header comment
(`__tests__/integration/trigger-enumeration.test.ts:5-25`) records the same incident independently,
with one detail `AGENTS.md` compresses: `mustChangePassword` was read into the `Identity` type and
returned by `resolveIdentity`, but nothing downstream branched on it. Both controls now have
production triggers: `bumpSessionEpoch` is called at `app/api/users/me/sessions/route.ts:36`
(defined at `lib/auth/identity.ts:329`), and `proxy.ts` no longer branches on `mustChangePassword`
— the only remaining occurrence is a comment at `proxy.ts:13` explaining that such decisions need a
fresh database read.

### 8.3 Three statements that were each correct

**Rule it justifies** — `AGENTS.md` §3, second reach question: "*Do the parts I changed still form a
consistent whole, or is each merely locally correct?*"

**What happened** — verbatim from `AGENTS.md` §3:

> Concrete instance: the Task 2 backfill wrote three statements that were each individually correct
> — and two derived `orgId` from the parent row while the third used a flat constant. No step ever
> asked whether the three composed. A composite foreign key then required exactly the property the
> inconsistent one could not guarantee. Locally correct, globally wrong.

### 8.4 The decomposition obligation

**Rule it justifies** — `AGENTS.md` §3, "*Decomposing something into parts — check the relations,
not the elements*", with its five numbered steps.

**Date** — 2026-08-03.

**Register row** — D-103, PROCESS FAILURE, opened 2026-08-03
(`docs/DEFERRED_REGISTER.md:149`), titled "Design-time completeness has no checkpoint: three defects
in one session all occurred **inside enumerations**, and self-review is 0-for-7 on this class".

**What happened** — the row was raised by the human partner at the Plan 1b spec review, in these
words: "*systems thinking and separation of concerns is consistently getting lost… the impact has a
radius.*" It was investigated with `rigor-loop` rather than conceded, and the claim held with one
sharpening. The three defects are listed in entry 7.4 above.

`AGENTS.md` states why the two obligations that already existed could not cover it:

> the two obligations above are both about a *unit*: one covers a new unit's interactions, the other
> covers a changed unit's dependents. **Neither asks whether a set of parts is complete or whether
> the parts compose** — and that is the obligation that failed three times in a single design
> session. Decomposition is where this is most needed and least likely to fire, because *breaking a
> thing into parts feels like understanding the whole* when it is the moment you stop looking at it.

The row adds the sharpening that made it fixable: relation-thinking is not absent, it is
*predictably* absent. The same session produced D-099, D-100 and the PDF-transaction finding, all
relation findings. It fires when a skill mandates a slot for it, or when an anomaly is encountered;
it fails while producing an enumeration.

**What changed** — §3's five-step decomposition obligation, plus the §2 trigger (entry 7.3) that
gives it an observable moment, plus the generate-do-not-write mechanism layer in entry 8.9.

### 8.5 The eight pages one lens could not see

**Rule it justifies** — `AGENTS.md` §3, decomposition step 2: "*Generate it again from a different
property and diff.*"

**Date** — 2026-08-03.

**What happened** — verbatim from `AGENTS.md` §3:

> The 8 pages missed on 2026-08-03 were invisible to "imports `prisma`" and obvious under "URL
> moves".

### 8.6 The route group three lenses all missed

**Rule it justifies** — `AGENTS.md` §3, decomposition step 2, second half: "*Vary the search root,
not only the predicate.*"

**Date** — 2026-08-03, hours after the obligation in 8.5 was written.

**What happened** — verbatim from `AGENTS.md` §3:

> **Vary the search *root*, not only the *predicate* — this is the harder half and it is where the
> rule was first broken.** Hours after this obligation was written, an adversarial pass found a
> whole route group (`app/(public)/**`, five pages including the registration form the plan
> explicitly modifies) that **three** successive lenses had all missed, because every one of them —
> "imports `prisma`", "is a page under `(authenticated)`", "holds a URL in `components/`" — searched
> the same three directories. Three different questions asked of the same subtree is one lens, not
> three, and no number of further predicates could have reached those files.

**What changed** — step 2 now leads with the question "*what is the root I keep searching, and what
lives outside it?*" before "what other property?".

### 8.7 Two exhaustive lists that never met

**Rule it justifies** — `AGENTS.md` §3, decomposition steps 3 and 4.

**What happened** — verbatim from `AGENTS.md` §3, step 3:

> An RBAC matrix and a route port were each exhaustive; nothing asked whether they touch, so `can()`
> could be perfect while every route consulted the wrong action.

And step 4:

> "An invitation adds a second user to an org" proves invitations work; it was written as proof of
> *two-org isolation*, which it cannot establish at all.

### 8.8 The what-if-oracle track record

**Rule it justifies** — `AGENTS.md` §3, decomposition step 5: run `what-if-oracle` on the
decomposition itself, aiming **Ψ Wild Card** and **∞ Second Order** at the whole design.

**Date** — 2026-08-03.

**Register row** — D-099, RISK, opened 2026-08-03 (`docs/DEFERRED_REGISTER.md:145`), titled
"Per-request identity reads concentrate load on the **owner** connection, and the obvious
performance fix re-opens D-075".

**What happened** — verbatim from `AGENTS.md` §3:

> Cheap, and it has a record: D-099 came from ∞, and the shared-lab-machine finding that set session
> `maxAge` came from Ψ.

D-103 records the same pair as "2-for-2" and credits the human partner with the correction that
produced this step: a claim that "nothing mechanical catches conceptual absence and only independent
review has a record" was too absolute, and the two oracle slots are built for exactly this.

What D-099 found is worth stating because it shows the shape of a second-order finding: moving
`role` and `mustChangePassword` out of the token means every authenticated request performs an
identity read; identity reads run on the owner connection (SUPERUSER, BYPASSRLS) because
`makrai_app` deliberately holds no privilege on `users` (D-075). So hardening session revocation
increases traffic against the one pool in the system that bypasses tenant isolation — at `max: 5` —
and the natural-looking remedy under load is `GRANT SELECT ON users TO makrai_app`, which is exactly
what D-075's own pick-up trigger predicted in writing: "*the temptation will be to re-grant the whole
table.*"

`AGENTS.md` also states why this invocation is distinct from the §2 fork trigger, and the
distinction is the load-bearing part:

> the fork trigger explores a decision **you have named**, so it cannot reach a decision **you never
> named** — which is the failure this obligation exists to catch.

D-103 states the same limit from the oracle's side: "the oracle finds absence within a decision you
have named, and cannot reach a decision you never named", because its Phase 1 requires naming the
variable.

### 8.9 Three proofs that generated lists beat written ones

**Rule it justifies** — `AGENTS.md` §3: "*Where a list must be complete, generate it rather than
writing it.*"

**What happened** — verbatim from `AGENTS.md` §3:

> this project has proven the move three times: `Record<keyof Prisma.UserInclude, …>` fails the
> build when a relation is added; the RBAC tests are generated over every (role × action) cell; T1
> enumerates tables from `pg_class` instead of listing them. A hand-written list that must be
> complete is a latent defect with a timestamp on it.

### 8.10 The cross-check that passed because it was the same measurement twice

**Rule it justifies** — `AGENTS.md` §3: "*Agreement between two checks is not corroboration when
both use the same lens.*"

**Date** — 2026-08-03.

**Register row** — recorded inside D-103 as "the sharpest evidence".

**What happened** — verbatim from `AGENTS.md` §3:

> On 2026-08-03 a 22-file inventory matched an ESLint allowlist *exactly*, and that exactness was
> read as validation — but the allowlist enumerates files importing `lib/db`, and the inventory was
> built by finding files importing `lib/db`. Same measurement twice. A loose match would have
> prompted a closer look; the precise one disarmed it.

D-103 adds that the allowlist in question was Plan 1a's, and that the match "was reported as
validation".

---

## 9. §4 — Delegation

### 9.1 Two stalls waiting for an agent that could never report back

**Rule it justifies** — `AGENTS.md` §4: "*If the dispatch permits the subagent to launch a helper,
it must say that a helper's output is PULLED, not awaited.*"

**Date** — Plan 1c; the C6 fix wave was 2026-08-10.

**What happened** — verbatim from `AGENTS.md` §4, first person preserved as written:

> A sub-agent's completion notification routes to the *controller*, not to the peer that launched it
> — so an agent that dispatches `silent-failure-hunter` (or any helper) and then waits for it will
> wait forever. This cost two stalls in Plan 1c: Task 8's implementer and the C6 fix wave each
> stopped mid-work with everything uncommitted, both reporting they were "waiting" for an agent that
> could never report back. Neither was the subagent's fault; both dispatches were mine and neither
> said so. Earlier tasks got away with it only because they happened to read the helper's output
> file instead of waiting.

**What changed** — the dispatch must tell the subagent to read the helper's output file, or to
proceed without it.

### 9.2 What the tree held during the rollback

**Rule it justifies** — `AGENTS.md` §4: "*Everything written is committed or declared*", and the C4
obligation to run `git status --porcelain --untracked-files=all` on receiving work.

**Date** — 2026-08-02.

**Register row** — D-063 (see 5.2), which lists the same files.

**What happened** — verbatim from `AGENTS.md` §4:

> During the 2026-08-02 rollback the tree held `scratch-probe.ts`, `scratch-probe2.ts` and a
> complete uncommitted `__tests__/integration/isolation.test.ts` — none had ever reached a review
> package.

The reason this is a finding and not housekeeping is stated at C4: review packages are built from
`git diff`, so an untracked file is invisible to every reviewer.

**Still recurring, recorded 2026-08-17.** The platform audit found `?? app/__effective_config_probe.ts`
in `git status` — an empty file — and noted the project's own C4 rule against it
(`docs/audits/2026-08-17-full-platform-audit-appendix.md:1511`).

### 9.3 The commit that contained nothing it claimed

**Rule it justifies** — `AGENTS.md` §4: "*The controller does not stage or commit while a subagent
is running.*"

**Date** — 2026-08-03.

**What happened** — verbatim from `AGENTS.md` §4, first person preserved as written:

> Between C2 and C4 the working tree belongs to the subagent. `git add -A` is repo-wide and does not
> know that: on 2026-08-03 the controller ran `git add -A && git commit -m "docs(ledger): …"` while
> a resumed implementer was mid-fix, and swept 24 lines of its in-progress `policy.test.ts` into a
> commit whose message described a ledger update — and the ledger is gitignored, so the commit
> contained nothing it claimed and everything it should not have. Recovered with
> `git reset --mixed HEAD~1`, which restores the index and HEAD without touching file contents.

`AGENTS.md` classifies it as the controller's own instance of §3: a repo-wide command whose reach was
never assessed.

**What changed** — mid-flight records go to the gitignored SDD workspace and are committed after C4.

---

## 10. §5 — Evidence

`AGENTS.md` §5 replaced three rules of the previous ruleset — inherited claims, self-generated
obstacle claims, and inability claims — which were one idea written three times (see entry 5.3).
Each row of its danger table carries an incident.

### 10.1 The inherited claim

**Rule it justifies** — §5 table, "Inherited from a document — Moderate".

**What happened** — verbatim from `AGENTS.md` §5:

> Four of eight Phase-0 bug rows were already fixed when copied.

### 10.2 The obstacle claim that felt like an observation

**Rule it justifies** — §5 table, "Generated by you to explain an obstacle — **Highest**"; and §6's
"a register row is not a substitute for trying".

**Date** — 2026-08-02.

**Register row** — D-068, PROCESS FAILURE, opened 2026-08-02
(`docs/DEFERRED_REGISTER.md:114`), titled "A register row was used to launder an unexamined problem,
and the audit that exists to catch process failures would have passed it".

**What happened** — verbatim from `AGENTS.md` §5:

> `fatal: ambiguous argument 'origin/HEAD...'` felt like "incompatible tool"; it meant "no git
> remote", fixable in one command.

The register row gives the full sequence, in the first person as recorded:

> `security-review` aborted with `fatal: ambiguous argument 'origin/HEAD...'`. Without looking at
> the skill, checking the repo's remote configuration, or attempting any fix, I declared it "cannot
> run in this repository", opened a register row saying so, and substituted a different skill.

The human partner challenged it — "*is it something that cannot be resolved or is too tasking to
resolve? Why are you papering over it?*" — and the investigation took **under two minutes**: the
repo had no git remote, so `origin/HEAD` did not resolve. One command fixed it,
`git symbolic-ref refs/remotes/origin/HEAD refs/heads/main`, verified to produce the correct
`main...HEAD` diff with `git remote -v` still empty. The fictional row (D-067, "skill cannot run")
was rewritten to the truth.

**What changed** — §5's ranking of claim danger, its four practices (one error message is a symptom
not a diagnosis; effort claims are claims; look at the thing itself; escalate with findings not
verdicts), and §6's evidence-of-attempt requirement for "I cannot" rows.

### 10.3 The conclusion that was true when derived

**Rule it justifies** — §5 table, "Derived by you earlier and reused — High"; and the §2 trigger on
reusing a previously-derived conclusion.

**What happened** — verbatim from `AGENTS.md` §5:

> The dev database "has existing rows" was true before I dropped and recreated it myself.

---

## 11. §6 — Recording what is not done

### 11.1 A todo is not a register row

**Rule it justifies** — `AGENTS.md` §6: a deferral gets a row in `docs/DEFERRED_REGISTER.md` in the
same commit that creates it, and "*A todo is **not** sufficient*".

**Date** — 2026-08-02.

**Register row** — D-063 (see 5.2).

**What happened** — verbatim from `AGENTS.md` §6:

> todos are session-local and evaporate, which is exactly how `security-review` was rescheduled past
> the change it existed to gate (D-063).

### 11.2 The laundered deferral

**Rule it justifies** — `AGENTS.md` §6: "*A register row is not a substitute for trying.*"

**Date** — 2026-08-02.

**Register row** — D-068 (see 10.2).

**What happened** — verbatim from `AGENTS.md` §6:

> This closes a failure worse than a silent skip, because it is camouflaged: a skipped step leaves a
> gap an audit finds, while a laundered deferral leaves a correct-looking row that **passes** the
> audit (D-068).

D-068 states why this is structural rather than a lapse of diligence: recording a deferral is the
virtuous-feeling action, so when something blocks you the row *feels* like compliance and
substitutes for solving the problem. It also records the concrete audit consequence: "D-063's own
pick-up condition would have sailed straight past D-067."

**What changed** — §6 now distinguishes "I have chosen not to" (needs justification and a trigger)
from "I cannot" (needs evidence of the attempt — the command and its output, or the source read).

### 11.3 Why this rule exists for this product in particular

**Rule it justifies** — the closing paragraph of `AGENTS.md` §6.

**What happened** — verbatim:

> A deferral silently forgotten is the documentation-deficit failure this product exists to diagnose
> (framework areas PO-03, PO-07). We do not get to commit it ourselves.

PO-03 and PO-07 are areas of the RAI assessment framework the platform implements; the argument is
that a governance tool cannot ship the failure mode it scores its users on.

---

## 12. §7 — Standing principles

### 12.1 What the preventive security pass caught

**Rule it justifies** — `AGENTS.md` §7.1, the "Preventive" row: `senior-security` at C1, on every
task touching auth, tenancy or data access, before code exists.

**What happened** — verbatim from the §7.1 table:

> Design defects. `text = uuid`, the `split_part` fail-open, and the unknown-role fail-open were all
> caught here

### 12.2 Why the threat table is re-derived per task

**Rule it justifies** — `AGENTS.md` §7.1: "*Derive the preventive obligations fresh per task.*"

**What happened** — verbatim from `AGENTS.md` §7.1:

> Reusing an earlier task's threat table is the §2 "reusing a previously-derived conclusion"
> trigger, and it is not a formality: re-deriving for Task 3 found a runtime fail-open that the table
> written before Task 1 did not contain. A conclusion that was sound when derived silently ages.

---

## 13. Rules in AGENTS.md that carry no incident

Listed so that the absence of an entry above is informative. These are conventions, definitions, or
derivations from a rule that does carry evidence — not provenance that went missing. The list was
built twice, as §3 requires of any list treated as complete: once by walking sections §0–§7 in
order, and once by enumerating every bullet and table row in `AGENTS.md` and striking the ones with
an entry above. The second pass added six rows the first had missed.

| Section | Rule | Why there is no incident |
|---|---|---|
| §0.1 | An amendment must state which checkpoint it binds to | Derived from the 2026-08-03 classification (entry 5.1) |
| §0.4 | Prefer converting a rule into a script, hook, or test | Convention; its evidence is the three proofs in entry 8.9 |
| §1 | The C1–C6 table itself | Definition |
| §1 C1 | Scan `docs/SKILLS_INVENTORY.md` and invoke the fitting skills before executing | Carries evidence, in entries 5.2 (D-063) and 6.1 (D-083) — listed here only because a reader may look for it under C1 |
| §1 C1 | State single responsibility and interactions | Points at §3, whose evidence is entries 8.1–8.3 |
| §1 C1 | Do not predict your mid-task triggers | Rationale, not an incident: pre-registering triggers as todos only catches triggers foreseen, and an emergent trigger is by definition one not foreseen |
| §1 C2 | Everything in §4 | Cross-reference |
| §1 C3 | Mid-execution binds controller and subagents alike | Definition |
| §1 C4 | `git status --porcelain --untracked-files=all` on receiving work | Carries evidence, in entry 9.2 (the 2026-08-02 tree) and entry 5.1 (it is one of the mechanisms that fired every time) |
| §1 C4 | Verify the claims yourself; a report is a set of assertions | Points at §5, whose evidence is entries 10.1–10.3 |
| §1 C4 | Assess reach | Points at §3, whose evidence is entry 8.2 |
| §1 C5 | Live end-to-end verification is the definition of done | Convention; the browser-launcher clause inside it carries entry 6.3 |
| §1 C5 | Run the verification command in this message | Convention |
| §1 C5 | Never declare work sound if the mandated process was bypassed | Convention, and the disclosure half of D-063 (entry 5.2), where the bypass was surfaced by the human partner rather than self-reported |
| §1 C6 | Review the register in full; no phase exits with an open row targeted at it | Convention |
| §1 C6 | `superpowers:finishing-a-development-branch` when ready to merge | Convention |
| §2 | Rows on scope creep, false brief assumptions, access-gating code, hard-to-reverse forks, reach divergence, deferral | Bindings of §3, §5, §6 and §7 obligations to observable moments; evidence sits with those sections |
| §3 | Architectural decisions get an ADR in `docs/adr/` | Convention |
| §4 | Every dispatch carries the process; states §2; names which altitude owns what; nothing written outside scope; reports are evidence | Generalised from D-063 (entry 5.2), which recorded subagents dispatched with briefs but no process obligation |
| §5 | The four practices | Distilled from entry 10.2 |
| §6 | Rows are closed, never deleted; closure cites the commit and states what was verified live | Convention |
| §7.2 | Honesty over completion | Standing principle |
| §7.3 | A process decision is judged at the moment it was made | Standing principle; applied in D-084 (entry 7.1), which refuses to defend a declination by its outcome |
| §7.4 | Requirements-driven; the live SPA is the baseline | Standing decision |

---

## 14. Maintenance rule

**This mirrors the same-commit register discipline in `AGENTS.md` §6, and for the same reason: a
record written later is a record not written.**

1. **When a rule is added to or amended in `AGENTS.md`, its incident is added here in the same
   commit.** An amendment whose provenance lands in a later commit is the failure §6 exists to stop —
   between the two commits, the rule is an assertion with no evidence behind it, and the evidence is
   in a session that has ended.
2. **The entry carries the same fields as every entry above**: the rule it justifies, the date, the
   register row if there is one, what happened, and what changed. Narrative is quoted verbatim, not
   summarised. Specifics — file names, error strings, counts, the exact words of a challenge from
   the human partner — are the value; a paraphrase that drops them has lost the thing worth keeping.
3. **`AGENTS.md` keeps the trigger; this file keeps the story.** If an amendment's text in
   `AGENTS.md` needs more than one clause of history to make sense, that history belongs here and
   the clause becomes a pointer.
4. **Entries are retired, never deleted** — the same rule the register uses for rows. If a rule
   leaves `AGENTS.md`, mark its entry `RETIRED <date> — rule removed from AGENTS.md because …` and
   leave it in place. A rule that was removed and later re-proposed needs its original evidence more
   than a live rule does.
5. **The check is mechanical.** Every register-row ID and every date in `AGENTS.md` must also appear
   here. Both are one command:

   ```bash
   # Register-row IDs cited in AGENTS.md but missing from this file — must print nothing
   comm -13 <(grep -oE 'D-[0-9]{3}' docs/process/RULE_PROVENANCE.md | sort -u) \
            <(grep -oE 'D-[0-9]{3}' AGENTS.md | sort -u)

   # Dates cited in AGENTS.md but missing from this file — must print nothing
   comm -13 <(grep -oE '2026-[0-9]{2}-[0-9]{2}' docs/process/RULE_PROVENANCE.md | sort -u) \
            <(grep -oE '2026-[0-9]{2}-[0-9]{2}' AGENTS.md | sort -u)
   ```

   Both were run against this file on 2026-08-18 and both printed nothing. Run them at C6, alongside
   the mechanical skill re-audit that `AGENTS.md` C6 already requires; they cost a second and they
   fail loudly, which is the property §0 says a rule needs in order to fire at all.

   The check is deliberately one-directional. This file may contain IDs and dates that `AGENTS.md`
   does not — retired entries, and supporting rows such as D-067, D-075, D-080, D-081 and D-100 that
   the narratives reference. It may never omit one that `AGENTS.md` cites.

---

## 15. Appendix — how this document's own claims were checked

Commands run against the working tree on 2026-08-18, from the repository root.

| Claim | Command | Output |
|---|---|---|
| `AGENTS.md` is 382 lines / 29,271 bytes | `wc -l -c AGENTS.md` | `382 29271 AGENTS.md` |
| 12 distinct register-row IDs | `grep -oE "D-[0-9]{3}" AGENTS.md \| sort -u` | `D-063 D-068 D-083 D-084 D-085 D-092 D-099 D-103 D-136 D-143 D-191 D-197` |
| 15 dated references | `grep -oE "2026-[0-9]{2}-[0-9]{2}" AGENTS.md \| sort \| uniq -c` | `2 2026-08-02`, `9 2026-08-03`, `1 2026-08-05`, `2 2026-08-10`, `1 2026-08-12` |
| Register row IDs, types, dates and line numbers | `grep -n -E "^\| D-(063\|068\|083\|084\|085\|092\|099\|103\|136\|143\|191\|197) \|" docs/DEFERRED_REGISTER.md` | rows at lines 109, 114, 129, 130, 131, 138, 145, 149, 185, 192, 240, 246 — as tabulated in section 4.1 |
| The three enumeration suites exist | `ls __tests__/integration/` | includes `trigger-enumeration.test.ts`, `port-completeness.test.ts`, `preauth-surface.test.ts` |
| `bumpSessionEpoch` now has a production caller | `grep -n "bumpSessionEpoch" app/api/users/me/sessions/route.ts lib/auth/identity.ts` | `app/api/users/me/sessions/route.ts:36: await bumpSessionEpoch(identity.userId);`; definition at `lib/auth/identity.ts:329` |
| `proxy.ts` no longer branches on `mustChangePassword` | `grep -n "mustChangePassword" proxy.ts` | one hit, a comment at `proxy.ts:13` |
| `AGENTS.md` is loaded into every session via `CLAUDE.md` | `cat CLAUDE.md` | `@AGENTS.md` (the whole file) |
| 24 lines of `AGENTS.md` carry a date or a register ID | `grep -cE '2026-[0-9]{2}-[0-9]{2}\|D-[0-9]{3}' AGENTS.md` | `24` |
| The C4 lens rule occupied 20 lines | `awk 'NR>=91 && NR<=110' AGENTS.md \| wc -l` | `20` |

**How the relocation was checked for completeness.** Two independent sweeps, because `AGENTS.md`
§3's own decomposition rule says one lens is not an inventory. The first was a hand-built list of
51 distinctive tokens (file names, error strings, numbers, tool names) grepped in both files: no
token present in `AGENTS.md` was absent here. The second was generated from a different property —
every numeric claim in `AGENTS.md`, extracted by pattern rather than by choosing what to look for
(`grep -oE '\b(zero|one|two|three|…|[0-9]+)[ -][A-Za-z][A-Za-z-]*|[0-9]+KB' AGENTS.md | sort -u`,
72 distinct matches) — and each was traced to an entry. Two claims found by the second sweep are
deliberately not relocated because they are rule text rather than evidence: "holding 200 lines in
mind at once" (§0's rationale for organising by moment) and "a helper doing three things with no
stated boundary" (§3's definition of a design defect).

**Scope boundary.** Both sweeps searched `AGENTS.md`. The register rows themselves stay in
`docs/DEFERRED_REGISTER.md` and are quoted here only where they add detail `AGENTS.md` compressed;
this file is not a second copy of the register and does not attempt to be.

Historical measurements quoted in this document — 1080 unit tests, a 726-cell permission matrix, a
57-test live browser walk, 28 branch commits, 205KB of re-read by Task 3, 24 lines of `policy.test.ts`
— are recorded as they stood on the dates given and were **not** re-measured. They are evidence about
those days, not claims about the current tree.
