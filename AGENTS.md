<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Operating instructions — MAK-AI RAI Toolkit

This project scales the RAI toolkit from a static SPA into a multi-user, cross-institutional,
persistent RAI-governance platform. Plan of record: `docs/VISION_AND_PLAN.md`. Skill inventory:
`docs/SKILLS_INVENTORY.md`. Read both at the start of a work session.

## §0 — How to use this document

**These rules are organised by *moment*, not by topic.** The question to ask is never "am I
violating something?" — that requires holding 200 lines in mind at once, which does not work.
The question is **"which checkpoint am I at, and what fires here?"** Go to that section, read
it, do what it says.

**Why it is shaped this way.** On 2026-08-03 the failures on this project were classified against
the rules that should have caught them. The result was unambiguous: **every rule bound to a
mechanical event held; every rule that depended on remembering an obligation at the right moment
failed.** `git status --untracked-files=all` fired every time. The same-commit register
requirement fired every time (git makes the omission visible). The `UserPromptSubmit` hook fired
every turn. Meanwhile "verify, do not transcribe", "design systems not components" and "triggers
are not only task-start" fired **zero** times unprompted, despite being written down for days.

So the design constraint on this document is:

> **An obligation that names no observable trigger will not fire. Adding emphasis does not
> change this.** If you cannot say *what event makes this rule fire*, it is a wish, not a rule.

**Maintaining these rules (this section is itself a rule):**

1. Any amendment must state **which checkpoint it binds to**. An amendment binding to no
   checkpoint is rejected — find its trigger or do not add it.
2. Before adding anything, check whether an existing principle already covers it. Rules 6, 8
   and 10 of the previous version were three statements of one idea, added on three separate
   days because each new instance was patched locally instead of recognised.
3. **Re-read this document end to end at every phase exit.** The previous version reached ten
   rules and 182 lines without anyone — including the agent editing it — having read it whole.
4. Prefer converting a rule into a script, hook, or test over restating it. Mechanism beats prose.

---

## §1 — Checkpoints

These are the moments. Each is triggered by something observable.

| # | Checkpoint | Fires when |
|---|---|---|
| **C1** | Task start | You begin any non-trivial task |
| **C2** | Before dispatch | You are about to hand work to a subagent |
| **C3** | **Mid-execution** | One of the §2 conditions occurs — *not* on a schedule |
| **C4** | On receiving work | A subagent reports, or you finish a chunk yourself |
| **C5** | Before claiming done | You are about to say complete, passing, working, or fixed |
| **C6** | Phase exit | A plan or phase is finished |

### C1 — Task start

- Scan `docs/SKILLS_INVENTORY.md`; invoke the fitting skills **before** executing. The always-on
  tier (rigor-loop, brainstorming, TDD, systematic-debugging, verification-before-completion,
  code-review, security-review) applies by default; the workstream tier applies by area. Missing
  from the inventory? Use it anyway and add it. Also harness-enforced by a `UserPromptSubmit` hook.
- **A process/orchestration skill never discharges the always-on tier.**
  `subagent-driven-development` and `executing-plans` decide *how work is sequenced and reviewed*.
  They supply no domain expertise and their reviews run after code exists, checking a diff against
  a brief. Symptom to catch: *"the review loop already covers this."* This exact substitution
  caused the 2026-08-02 rollback (D-063) — five tasks of tenancy work with no
  `database-design:postgresql` and no `security-review`.
- State the task's **single responsibility and what is explicitly not its job**, and **what it
  interacts with, including layers it does not call directly** (see §3).
- Do **not** try to predict your mid-task triggers. The previous version required pre-registering
  them as todos; that only catches triggers you foresaw, and an emergent trigger is by definition
  one you did not. C3 replaces prediction with observation.

### C2 — Before dispatch

Everything in §4. In particular the dispatch must carry the *process*, not just the task.

### C3 — Mid-execution

**This is the checkpoint the previous ruleset did not have.** See §2 for the trigger conditions.
Binds the controller *and* every subagent.

### C4 — On receiving work

- `git status --porcelain --untracked-files=all` — untracked residue is a finding, not noise.
  Review packages are built from `git diff`, so an untracked file is invisible to every reviewer.
- Verify the claims yourself against the gold standard; a report is a set of assertions (§5).
- Assess **reach** (§3): what does this change affect beyond the files it edited?
- **Security here is the preventive pass, not the diff scan** — see §7.1 for why they are split
  and which fires when. The diff scan lives at C6.

### C5 — Before claiming done

- **Live end-to-end verification is the definition of done.** Driven through the real running app
  in a browser (Playwright / Chrome DevTools) and observed to work — not merely builds,
  type-checks, or passes tests. State plainly what was and was not verified live.
- Run the verification command **in this message**. A previous run is not evidence about the
  current state.
- Never declare work sound if the mandated process was bypassed. Say what was skipped.

### C6 — Phase exit

- Run **`security-review` over the whole branch diff.** This is its natural granularity: the skill
  resolves `git diff origin/HEAD...`, so it re-reads the entire branch on every invocation. Run
  per-task it re-reviews already-reviewed code at compounding cost (205KB by Task 3) while adding
  little — the per-task security work that actually finds things is the *preventive* pass (§7.1).
  Moved here from C4 by amendment on 2026-08-03, with the human partner's approval, after
  measuring the cost rather than assuming it.
- Review `docs/DEFERRED_REGISTER.md` in full. No phase exits with an open row targeted at that
  phase unless explicitly re-targeted with justification.
- Re-read this document end to end (§0.3).

---

## §2 — Mid-execution triggers

**Each is an observable condition, not a prediction.** When one occurs, stop and do the action
before continuing. This applies to subagents exactly as it applies to the controller.

| When you notice… | Stop and… |
|---|---|
| You are about to work around something that failed | Investigate it first (§5). One failed attempt is where investigating starts, not where it concludes. |
| You are about to write or say *cannot*, *too costly*, *not applicable*, *unsupported* | Treat it as a factual claim needing evidence (§5). |
| You are touching a file the brief did not name | Ask whether this is still your task's scope. If it is scope creep, stop. If the brief was wrong, say so. |
| An assumption in the brief turns out to be false | Report it — do not silently correct and continue. The brief's author needs to know. |
| You are about to write anything that gates access — a policy, role grant, `where`, auth check, session read | `security-review` / `senior-security` applies now, not at the end. |
| You reach a choice that would be expensive to reverse — data model, tenancy, scoring, identity | `what-if-oracle`. This is mandatory at these forks, not situational. |
| The change is reaching further than the task described | Assess reach (§3) and report the divergence. |
| You are about to reuse a previously-derived conclusion | Re-derive it, or state explicitly that you are reusing it and why that is valid now (§5). |
| You are about to defer, substitute, or park anything | §6. |

---

## §3 — Design and change

**Designing something new.** State in writing: (a) what is this unit's single responsibility, and
what is explicitly *not* its job; (b) how does it interact with every layer it touches, including
the ones it does not call directly. A helper doing three things with no stated boundary is a
design defect even when it works. Most defects here have been *interaction* defects: rate limiting
worked but its in-memory store broke under multi-instance hosting; logout worked but a JWT
decision elsewhere made it unrevocable; `orgDb` was specified as "inject orgId **and** enforce
role **and** set the GUC", which is why it was ambiguous whether it filtered at all. Components
verified in isolation compose into a broken system. Architectural decisions get an ADR in
`docs/adr/`.

**Changing something that exists — determine its reach.** This is a distinct obligation and it was
missing entirely from the previous version, which was written only for construction. For every
change, before and after:

- What else reads, writes, or depends on this?
- Do the parts I changed still form a *consistent whole*, or is each merely locally correct?
- What did this change make possible that was not possible before?
- What now happens on the paths I did not touch?

Concrete instance: the Task 2 backfill wrote three statements that were each individually correct
— and two derived `orgId` from the parent row while the third used a flat constant. No step ever
asked whether the three composed. A composite foreign key then required exactly the property the
inconsistent one could not guarantee. Locally correct, globally wrong.

---

## §4 — Delegation

Subagents are bound by these rules, not exempt. The controller does not get to launder a shortcut
by delegating it.

- **Every dispatch carries the process.** The prompt must require the subagent to scan
  `docs/SKILLS_INVENTORY.md` and invoke the fitting skill *before* writing code, and to name what
  it invoked in its report. Hand-feeding a brief and constraints tells it *what* to build while
  silently exempting it from *how* this project builds.
- **The dispatch states §2 explicitly.** A subagent cannot honour mid-execution triggers it was
  never given.
- **The dispatch names which altitude owns what.** Say whether security review, live verification
  and reach assessment sit with the controller or the subagent. Left unsaid, each assumes the
  other did it, and the reviewer reads the silence as a gap.
- **Nothing is written outside assigned scope** — not even as a head start for a later task.
- **Everything written is committed or declared.** During the 2026-08-02 rollback the tree held
  `scratch-probe.ts`, `scratch-probe2.ts` and a complete uncommitted
  `__tests__/integration/isolation.test.ts` — none had ever reached a review package.
- **Reports are evidence, not assurances.** State what was run and what the output was.
- **The controller does not stage or commit while a subagent is running.** Between C2 and C4 the
  working tree belongs to the subagent. `git add -A` is repo-wide and does not know that: on
  2026-08-03 the controller ran `git add -A && git commit -m "docs(ledger): …"` while a resumed
  implementer was mid-fix, and swept 24 lines of its in-progress `policy.test.ts` into a commit
  whose message described a ledger update — and the ledger is gitignored, so the commit contained
  nothing it claimed and everything it should not have. Recovered with `git reset --mixed HEAD~1`,
  which restores the index and HEAD without touching file contents. If you must record something
  mid-flight, write to the gitignored SDD workspace and commit after C4. This is the controller's
  own instance of §3: a repo-wide command whose reach was never assessed.

---

## §5 — Evidence

*(This replaces three rules of the previous version — inherited claims, self-generated obstacle
claims, and inability claims — which were one idea written three times.)*

**An assertion is a hypothesis until checked. This holds regardless of where the assertion came
from**, and the ranking of danger runs opposite to intuition:

| Source of claim | Danger | Why |
|---|---|---|
| Inherited from a document | Moderate | Visibly second-hand, so doubt comes naturally. Four of eight Phase-0 bug rows were already fixed when copied. |
| Generated by you to explain an obstacle | **Highest** | Arrives already feeling like an observation. `fatal: ambiguous argument 'origin/HEAD...'` felt like "incompatible tool"; it meant "no git remote", fixable in one command. |
| Derived by you earlier and reused | High | Was true when derived; silently ages. The dev database "has existing rows" was true before I dropped and recreated it myself. |

Practices:

- **One error message is a symptom, not a diagnosis.**
- **Effort claims are claims.** "Too costly", "too invasive", "large refactor" need the same
  grounding as any other. Do not assert a cost you have not scoped.
- **Look at the thing itself.** Read the tool, skill, or config definition before theorising. The
  answer is usually in the first file you did not open.
- **Escalate with findings, not verdicts.** "I ran X, got Y, cause is Z, here are the options" —
  not "X doesn't work here." A verdict ends an investigation your human partner might continue.
- **Cite the file and line, or the command and its output**, for load-bearing claims.

---

## §6 — Recording what is not done

Every conscious decision to not-do-something-now — deferral, parked decision, accepted risk, known
bug, **or a triggered skill not run** — gets a row in `docs/DEFERRED_REGISTER.md` **in the same
commit that creates it**, with why and a concrete pick-up trigger. "Later" is not a pick-up
condition. Rows are closed, never deleted; closure cites the commit and states what was verified
live. A todo is **not** sufficient — todos are session-local and evaporate, which is exactly how
`security-review` was rescheduled past the change it existed to gate (D-063).

**A register row is not a substitute for trying.** Opening a row on *"I cannot"* grounds requires
evidence of the attempt — the command and its output, or the source read — exactly as closing one
does. *"I have chosen not to"* needs only justification and a trigger. This closes a failure worse
than a silent skip, because it is camouflaged: a skipped step leaves a gap an audit finds, while a
laundered deferral leaves a correct-looking row that **passes** the audit (D-068).

A deferral silently forgotten is the documentation-deficit failure this product exists to diagnose
(framework areas PO-03, PO-07). We do not get to commit it ourselves.

---

## §7 — Standing principles

These have no single checkpoint; they bind everywhere.

1. **Security is foundational.** Tenant isolation and object-level authorization are verified on
   every change touching auth, tenancy, or data access — not deferred. Two halves, different
   instruments, different cadences, both required:

   | | Instrument | Fires | Catches |
   |---|---|---|---|
   | **Preventive** | `senior-security` — threat-model *this task*, derive what it must prove, put the obligations in the brief | **Every** such task, at C1, before code exists | Design defects. `text = uuid`, the `split_part` fail-open, and the unknown-role fail-open were all caught here |
   | **Detective** | `security-review` — scan the diff | **C6**, over the whole branch | What got built rather than what was intended |

   **Derive the preventive obligations fresh per task.** Reusing an earlier task's threat table is
   the §2 "reusing a previously-derived conclusion" trigger, and it is not a formality: re-deriving
   for Task 3 found a runtime fail-open that the table written before Task 1 did not contain.
   A conclusion that was sound when derived silently ages.
2. **Honesty over completion.** Label unverified work unverified. Surface assumptions, gaps and
   unconfirmed things rather than papering over them.
3. **A process decision is judged at the moment it was made, not by how it turned out.**
   "It was adequate" is not a defence of a choice that was wrong when taken — it is survivorship
   reasoning, and it would have produced the same verdict right up until the moment it failed.
4. **Requirements-driven.** The live SPA is the baseline. Prior implementation artifacts —
   including anything on `rollback/*` branches — are references to evaluate on merit, not
   mandates. External/personal logistics are not design inputs unless raised.

---

## Decisions locked (see docs/VISION_AND_PLAN.md §3)
- Primary adopter: **team self-improvement**.
- Standards: **ISO/IEC 42001** + **African Union Continental AI Strategy (2024)** / **UNESCO EIA**.
