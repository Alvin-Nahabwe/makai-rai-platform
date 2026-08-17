<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Operating instructions — MAK-AI RAI Toolkit

This project scales the RAI toolkit from a static SPA into a multi-user, cross-institutional,
persistent RAI-governance platform. Plan of record: `docs/VISION_AND_PLAN.md`. Skill inventory:
`docs/SKILLS_INVENTORY.md`. Read both at the start of a work session.

## §0 — How to use this document

Nearly every rule here was written in response to a specific failure. That evidence — incident, date,
measurement, register row — lives in `docs/process/RULE_PROVENANCE.md`, indexed by register row and by
date, one section there per section here. It is deliberately **not** loaded into every session: the
checkpoints and the §2 trigger table do the binding day to day, and a rule that is firing needs its
trigger and its action, not its history. Read it at phase exits (§0.3) and when amending a rule
(§0.2). **A new or amended rule's incident is added there in the same commit that changes the rule**
— the same discipline §6 imposes on register rows, for the same reason: a record written later is a
record not written. Citations below of the form **(D-063; PROVENANCE §5.2)** name the row in
`docs/DEFERRED_REGISTER.md` and the entry in `docs/process/RULE_PROVENANCE.md` that carries the account.

**These rules are organised by *moment*, not by topic.** The question to ask is never "am I violating
something?" — that requires holding 200 lines in mind at once, which does not work. The question is
**"which checkpoint am I at, and what fires here?"** Go to that section, read it, do what it says.
Every rule bound to a mechanical event has held here; every rule that depended on remembering an
obligation at the right moment has failed (PROVENANCE §5.1). So the design constraint is:

> **An obligation that names no observable trigger will not fire. Adding emphasis does not
> change this.** If you cannot say *what event makes this rule fire*, it is a wish, not a rule.

**Maintaining these rules (this section is itself a rule):**

1. Any amendment must state **which checkpoint it binds to**. An amendment binding to no checkpoint
   is rejected — find its trigger or do not add it.
2. Before adding anything, check whether an existing principle already covers it. Patching each new
   instance locally produces one idea written three times (PROVENANCE §5.3).
3. **Re-read this document end to end at every phase exit** (PROVENANCE §5.4).
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
| **C7** | Before committing | You are about to run `git commit` |

### C1 — Task start

- Scan `docs/SKILLS_INVENTORY.md`; invoke the fitting skills **before** executing. The always-on
  tier (rigor-loop, brainstorming, TDD, systematic-debugging, verification-before-completion,
  code-review, security-review) applies by default; the workstream tier applies by area. Missing
  from the inventory? Use it anyway and add it. Also harness-enforced by a `UserPromptSubmit` hook.
- **A process/orchestration skill never discharges the always-on tier.**
  `subagent-driven-development` and `executing-plans` decide *how work is sequenced and reviewed*.
  They supply no domain expertise and their reviews run after code exists, checking a diff against a
  brief. Symptom to catch: *"the review loop already covers this."* Schema, tenancy and data-access
  work needs `database-design:postgresql` and `security-review` in their own right, whatever the
  orchestration skill reports (D-063; PROVENANCE §5.2).
- State the task's **single responsibility and what is explicitly not its job**, and **what it
  interacts with, including layers it does not call directly** (see §3).
- Do **not** try to predict your mid-task triggers. Pre-registering them as todos catches only the
  triggers you foresaw, and an emergent trigger is by definition one you did not. C3 replaces
  prediction with observation.

### C2 — Before dispatch

Everything in §4. In particular the dispatch must carry the *process*, not just the task.

### C3 — Mid-execution

See §2 for the trigger conditions. Binds the controller *and* every subagent.

### C4 — On receiving work

- `git status --porcelain --untracked-files=all` — untracked residue is a finding, not noise.
  Review packages are built from `git diff`, so an untracked file is invisible to every reviewer.
- Verify the claims yourself against the gold standard; a report is a set of assertions (§5).
- **Apply the `code-review` and `simplify` LENSES to the chunk — code-review first, then simplify on
  what you are keeping** (D-083; PROVENANCE §6.1).
  **What does not discharge them:** a spec-compliance verdict. A reviewer answering "does this diff
  match its brief?" has reviewed neither correctness nor clarity, and counting it as though it had is
  the orchestration substitution named in C1. **The discharge requires a separate, explicit verdict
  per lens**, and a lens that finds nothing must say so plainly rather than manufacture a finding.
  **What does discharge them:** either the controller invoking the skills directly, *or* a dispatched
  reviewer applying both lenses by direct analysis and returning a verdict for each. The lens is the
  obligation; the tool is one way of carrying it (D-197; PROVENANCE §6.2).
- Assess **reach** (§3): what does this change affect beyond the files it edited?
- **Security here is the preventive pass, not the diff scan** — see §7.1 for why they are split and
  which fires when. The diff scan lives at C6.

### C5 — Before claiming done

- **Live end-to-end verification is the definition of done.** Driven through the real running app in
  a browser (the `run` skill, Playwright, or Chrome DevTools) and observed to work — not merely
  builds, type-checks, or passes tests. State plainly what was and was not verified live. If one
  browser launcher fails, try another before concluding none is available (PROVENANCE §6.3).
- Run the verification command **in this message**. A previous run is not evidence about the current
  state.
- Never declare work sound if the mandated process was bypassed. Say what was skipped.

### C6 — Phase exit

- Run **`security-review` over the whole branch diff.** This is its natural granularity: the skill
  resolves `git diff origin/HEAD...`, so it re-reads the entire branch on every invocation. Run
  per-task it re-reviews reviewed code at compounding cost while adding little — the per-task
  security work that finds things is the *preventive* pass (§7.1; PROVENANCE §6.4).
- Review `docs/DEFERRED_REGISTER.md` in full. No phase exits with an open row targeted at that phase
  unless explicitly re-targeted with justification.
- Re-read this document end to end (§0.3).
- **Re-audit skill invocation mechanically**: grep the SDD ledger and the branch commits for every
  skill named in `docs/SKILLS_INVENTORY.md`, and compare the ones bound to a checkpoint against the
  ones that are not. Recollection does not substitute (PROVENANCE §6.5).
- When the branch is ready to merge, `superpowers:finishing-a-development-branch`.

### C7 — Before committing

- **Read the message as someone who was not present.** Does it describe *the change*, or *the doing
  of the change*? The second is the defect.
- **Qualify every identifier on first use** — "AGENTS.md §1 C4", "D-063 (DEFERRED_REGISTER)",
  "Plan 1c Task 5". A bare pointer tells the reader nothing about where to look.
- **Every load-bearing claim carries a file:line, or a command and its output.** This is §5's
  existing rule; commit bodies currently honour it in 27% of cases.
- **Never cite a path under a gitignored directory** — the path is dead on arrival, and three
  published commits cite `.superpowers/` paths that no longer exist. If the evidence matters, commit
  the evidence somewhere it survives.
- **Session narrative goes to the register or the gitignored workspace, never into permanent history.**
- Full rules: `docs/COMMIT_CONVENTION.md`.

---

## §2 — Mid-execution triggers

**Each is an observable condition, not a prediction.** When one occurs, stop and do the action
before continuing. This applies to subagents exactly as it applies to the controller.

| When you notice… | Stop and… |
|---|---|
| You are about to work around something that failed | Investigate it first (§5) — invoke **`superpowers:systematic-debugging`**. One failed attempt is where investigating starts, not where it concludes. (D-084; PROVENANCE §7.1) |
| You are about to write error handling, a fallback, a `catch`, or a default value | Dispatch **`pr-review-toolkit:silent-failure-hunter`** (an *agent*, not a skill). It is the one tool aimed exactly at the silent fail-open shape this project has shipped. (D-085; PROVENANCE §7.2) |
| You are about to write or say *cannot*, *too costly*, *not applicable*, *unsupported* | Treat it as a factual claim needing evidence (§5). |
| You are touching a file the brief did not name | Ask whether this is still your task's scope. If it is scope creep, stop. If the brief was wrong, say so. |
| An assumption in the brief turns out to be false | Report it — do not silently correct and continue. The brief's author needs to know. |
| You are about to write anything that gates access — a policy, role grant, `where`, auth check, session read | `security-review` / `senior-security` applies now, not at the end. |
| You reach a choice that would be expensive to reverse — data model, tenancy, scoring, identity | `what-if-oracle`. This is mandatory at these forks, not situational. |
| The change is reaching further than the task described | Assess reach (§3) and report the divergence. |
| You are about to reuse a previously-derived conclusion | Re-derive it, or state explicitly that you are reusing it and why that is valid now (§5). |
| **You have just produced an enumeration that will be treated as complete** — a file list, a test matrix, a task sequence, a set of proof obligations | Run §3's **decomposition** obligation before going further. Do **not** skip it because the list feels thorough — that feeling is the failure mode, not a reason to trust it. (D-103; PROVENANCE §7.3) |
| **You have finished a design artifact** — a spec, an ADR, a plan, a decomposition — and are about to put it in front of your human partner | **`engineering-skills:adversarial-reviewer`**, briefed to attack the **decomposition** — *"what is missing, and what lens would reveal it?"* — not to review the content. Self-review does not catch this class; independent review does. (D-092, D-103; PROVENANCE §7.4) |
| **You are about to hand over a plan or a task brief** | Two checks, both mechanical, both cheap. **(1) Execute the claims.** Any statement in the brief about how a library, database or tool *behaves* is run before the brief ships, and the brief cites the command and its output; if it cannot be run, mark it in the brief as an assumption for the implementer to check rather than inherit. **(2) Pair reads and writes.** Every value the plan says is read must have a named writer, and every value written a named reader — verified by grep, not by memory. (D-136, D-143; PROVENANCE §7.5) |
| **You are about to record an obligation as discharged** — in a report, a commit message, a coverage map, or a register closure | State the obligation's **property** in your own words. State what the test actually **causes to happen**. Then ask whether the second entails the first — specifically, *could the property be violated by some other mechanism while this test still passes?* If yes, the test does not discharge the obligation; name the gap instead of closing it. **`trigger-enumeration.test.ts` cannot substitute for this reading** — it greps for mechanisms, so a guard on the wrong surface satisfies it exactly. (D-191; PROVENANCE §7.6) |
| You are about to defer, substitute, or park anything | §6. |

---

## §3 — Design and change

**Designing something new.** State in writing: (a) what is this unit's single responsibility, and
what is explicitly *not* its job; (b) how does it interact with every layer it touches, including the
ones it does not call directly. A helper doing three things with no stated boundary is a design
defect even when it works. Most defects here have been *interaction* defects: components verified in
isolation compose into a broken system (PROVENANCE §8.1). Architectural decisions get an ADR in
`docs/adr/`.

**Changing something that exists — determine its reach.** For every change, before and after:

- What else reads, writes, or depends on this?
- Do the parts I changed still form a *consistent whole*, or is each merely locally correct?
  (PROVENANCE §8.3)
- What did this change make possible that was not possible before?
- What now happens on the paths I did not touch?

**The fourth question is the one that keeps not getting asked, so it now has a mechanism.** Its
failure class is *"a control whose enforcement point moved while its trigger stayed behind"*, and it
is invisible in any single task's diff. **So no diff-scoped review of any kind can catch it** — not
`code-review`, not the task reviewer, not an adversarial pass on the same diff. Only whole-tree
analysis can, which is why C6 runs at branch granularity (PROVENANCE §8.2). The mechanical form:
**`__tests__/integration/trigger-enumeration.test.ts`** enumerates, from disk, the production callers
of guards that must be wired and the read-sites of columns that gate behaviour, and fails when one
has none. When you add a guard or a gating column, add it there. `port-completeness` and
`preauth-surface` already enumerate *surfaces*; this enumerates *triggers*, and the gap between those
two words is where that class lives.

**Decomposing something into parts — check the relations, not the elements.** The two obligations
above are both about a *unit*: one covers a new unit's interactions, the other a changed unit's
dependents. **Neither asks whether a set of parts is complete or whether the parts compose.**
Decomposition is where this is most needed and least likely to fire, because *breaking a thing into
parts feels like understanding the whole* when it is the moment you stop looking at it (D-103;
PROVENANCE §8.4). A list's correctness is **entirely** in its relations — every element can be right
while the list is wrong. So, whenever you produce one:

1. **Name the property that generated it.** "Files importing `prisma`." "Routes that mutate."
2. **Generate it again from a different property and diff.** One lens is not an inventory
   (PROVENANCE §8.5). **Vary the search *root*, not only the *predicate* — this is the harder half
   and it is where the rule was first broken.** Three different questions asked of the same subtree
   are one lens, not three, and no number of further predicates can reach what lives outside it. Ask
   *"what is the root I keep searching, and what lives outside it?"* before asking "what other
   property?" (PROVENANCE §8.6)
3. **State what connects the items**, not only what they are. Two individually exhaustive lists that
   nothing checks for contact leave the defect between them (PROVENANCE §8.7).
4. **For each verification item, state the claim it proves** — then check it proves *that* claim and
   not a neighbouring one (PROVENANCE §8.7).
5. **Run `what-if-oracle` on the decomposition itself** — the What-If is *"what if this ships exactly
   as specified?"*, not a named variable. **Ψ Wild Card** ("a variable nobody is tracking") and
   **∞ Second Order** are the slots that surface a question nobody asked, and they are only pointed at
   the whole design if you aim them there. This is a *distinct* invocation from the §2 fork trigger,
   and the difference is the point: the fork trigger explores a decision **you have named**, so it
   cannot reach a decision **you never named** — the failure this obligation exists to catch. Cheap,
   and it has a record (D-099; PROVENANCE §8.8).

**Where a list must be complete, generate it rather than writing it.** Mechanism beats prose (§0.4),
and this project has proven the move three times (PROVENANCE §8.9). A hand-written list that must be
complete is a latent defect with a timestamp on it.

**Agreement between two checks is not corroboration when both use the same lens.** Two lists built
from the same predicate are one measurement taken twice; an exact match between them disarms
scrutiny rather than earning it (PROVENANCE §8.10).

---

## §4 — Delegation

Subagents are bound by these rules, not exempt. The controller does not get to launder a shortcut by
delegating it.

- **Every dispatch carries the process.** The prompt must require the subagent to scan
  `docs/SKILLS_INVENTORY.md` and invoke the fitting skill *before* writing code, and to name what it
  invoked in its report. Hand-feeding a brief and constraints tells it *what* to build while silently
  exempting it from *how* this project builds.
- **The dispatch states §2 explicitly.** A subagent cannot honour mid-execution triggers it was never
  given.
- **The dispatch names which altitude owns what.** Say whether security review, live verification and
  reach assessment sit with the controller or the subagent. Left unsaid, each assumes the other did
  it, and the reviewer reads the silence as a gap.
- **If the dispatch permits the subagent to launch a helper, it must say that a helper's output is
  PULLED, not awaited.** A sub-agent's completion notification routes to the *controller*, not to the
  peer that launched it — so an agent that dispatches `silent-failure-hunter` (or any helper) and
  then waits for it will wait forever. Tell it to read the helper's output file, or to proceed
  without it (PROVENANCE §9.1).
- **Nothing is written outside assigned scope** — not even as a head start for a later task.
- **Everything written is committed or declared.** Probe scripts and uncommitted tests are the
  recurring shape here (PROVENANCE §9.2).
- **Reports are evidence, not assurances.** State what was run and what the output was.
- **The controller does not stage or commit while a subagent is running.** Between C2 and C4 the
  working tree belongs to the subagent, and `git add -A` is repo-wide and does not know that — it
  sweeps in-progress work into a commit whose message describes something else (PROVENANCE §9.3). If
  it happens, `git reset --mixed HEAD~1` restores the index and HEAD without touching file contents.
  If you must record something mid-flight, write to the gitignored SDD workspace and commit after C4.
  This is the controller's own instance of §3: a repo-wide command whose reach was never assessed.

---

## §5 — Evidence

**An assertion is a hypothesis until checked. This holds regardless of where the assertion came
from**, and the ranking of danger runs opposite to intuition:

| Source of claim | Danger | Why |
|---|---|---|
| Inherited from a document | Moderate | Visibly second-hand, so doubt comes naturally (PROVENANCE §10.1). |
| Generated by you to explain an obstacle | **Highest** | Arrives already feeling like an observation (PROVENANCE §10.2). |
| Derived by you earlier and reused | High | Was true when derived; silently ages (PROVENANCE §10.3). |

Practices:

- **One error message is a symptom, not a diagnosis.**
- **Effort claims are claims.** "Too costly", "too invasive", "large refactor" need the same grounding
  as any other. Do not assert a cost you have not scoped.
- **Look at the thing itself.** Read the tool, skill, or config definition before theorising. The
  answer is usually in the first file you did not open.
- **Escalate with findings, not verdicts.** "I ran X, got Y, cause is Z, here are the options" — not
  "X doesn't work here." A verdict ends an investigation your human partner might continue.
- **Cite the file and line, or the command and its output**, for load-bearing claims.

---

## §6 — Recording what is not done

Every conscious decision to not-do-something-now — deferral, parked decision, accepted risk, known
bug, **or a triggered skill not run** — gets a row in `docs/DEFERRED_REGISTER.md` **in the same commit
that creates it**, with why and a concrete pick-up trigger. "Later" is not a pick-up condition. Rows
are closed, never deleted; closure cites the commit and states what was verified live. A todo is
**not** sufficient — todos are session-local and evaporate, taking the obligation with them
(D-063; PROVENANCE §11.1).

**A register row is not a substitute for trying.** Opening a row on *"I cannot"* grounds requires
evidence of the attempt — the command and its output, or the source read — exactly as closing one
does. *"I have chosen not to"* needs only justification and a trigger. This closes a failure worse
than a silent skip, because it is camouflaged: a skipped step leaves a gap an audit finds, while a
laundered deferral leaves a correct-looking row that **passes** the audit (D-068; PROVENANCE §11.2).

A deferral silently forgotten is the documentation-deficit failure this product exists to diagnose
(framework areas PO-03, PO-07). We do not get to commit it ourselves.

---

## §7 — Standing principles

These have no single checkpoint; they bind everywhere.

1. **Security is foundational.** Tenant isolation and object-level authorization are verified on every
   change touching auth, tenancy, or data access — not deferred. Two halves, different instruments,
   different cadences, both required:

   | | Instrument | Fires | Catches |
   |---|---|---|---|
   | **Preventive** | `senior-security` — threat-model *this task*, derive what it must prove, put the obligations in the brief | **Every** such task, at C1, before code exists | Design defects, including the fail-opens this project shipped (PROVENANCE §12.1) |
   | **Detective** | `security-review` — scan the diff | **C6**, over the whole branch | What got built rather than what was intended |

   **Derive the preventive obligations fresh per task.** Reusing an earlier task's threat table is the
   §2 "reusing a previously-derived conclusion" trigger, and it is not a formality: a conclusion that
   was sound when derived silently ages (PROVENANCE §12.2).
2. **Honesty over completion.** Label unverified work unverified. Surface assumptions, gaps and
   unconfirmed things rather than papering over them.
3. **A process decision is judged at the moment it was made, not by how it turned out.** "It was
   adequate" is not a defence of a choice that was wrong when taken — it is survivorship reasoning,
   and it would have produced the same verdict right up until the moment it failed.
4. **Requirements-driven.** The live SPA is the baseline. Prior implementation artifacts — including
   anything on `rollback/*` branches — are references to evaluate on merit, not mandates.
   External/personal logistics are not design inputs unless raised.

---

## Decisions locked (see docs/VISION_AND_PLAN.md §3)
- Primary adopter: **team self-improvement**.
- Standards: **ISO/IEC 42001** + **African Union Continental AI Strategy (2024)** / **UNESCO EIA**.
