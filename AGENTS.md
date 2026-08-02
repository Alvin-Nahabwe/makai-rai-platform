<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Operating instructions — MAK-AI RAI Toolkit

This project scales the RAI toolkit from a static SPA into a multi-user, cross-institutional,
persistent RAI-governance platform. The plan of record is `docs/VISION_AND_PLAN.md`; the skill
inventory is `docs/SKILLS_INVENTORY.md`. Read both at the start of a work session.

## Standing rules

1. **Consult skills before each task.** Before starting any non-trivial task, scan
   `docs/SKILLS_INVENTORY.md` for a fitting skill, invoke it, and only then execute. The
   always-on tier (rigor-loop, brainstorming, TDD, systematic-debugging,
   verification-before-completion, code-review, security-review) applies by default;
   the workstream tier applies by the area you're working in. If a relevant skill isn't
   in the inventory yet, use it anyway and add it. Skill availability is verified at the
   point of use. This rule is also harness-enforced by a global `UserPromptSubmit` hook.

   **Triggers are not only task-start.** Some skills fire on events that arise partway
   through the work — notably `what-if-oracle` when you reach a hard-to-reverse fork
   (tenancy model, data model, scoring methodology), and `security-review` when a change
   turns out to touch auth, tenancy, or data access. A scan-before-you-start habit
   structurally under-fires for these. So: before starting, name the skills the whole task
   will need **including the fork points you expect to hit**, and record each as a tracked
   todo item, so a mid-task trigger cannot be silently skipped.

   **A process/orchestration skill never discharges the always-on tier.** Invoking
   `superpowers:subagent-driven-development` or `executing-plans` decides *how work is
   sequenced and reviewed*. It supplies no domain expertise, and its reviews run **after**
   code exists, checking a diff against a brief. The always-on and workstream tiers bring
   expertise **before** the code is written. Letting the orchestrator's internal review
   loop stand in for `code-review`, `verification-before-completion`, `security-review`,
   or the domain tier is the specific failure that caused the 2026-08-02 Phase-1a
   rollback (register D-063): five tasks of tenancy work — schema, tenant port, RBAC,
   data-access layer, RLS — were built with no `database-designer`, no
   `database-design:postgresql`, and no `security-review`, because the orchestrator
   *felt* like the process. Symptom to watch for: reaching for a skill and thinking
   "the review loop already covers this."

2. **Live end-to-end verification is the definition of done.** "Done" means the change
   was driven through the real running app in a browser (Playwright / Chrome DevTools) and
   observed to work — not merely that it builds, type-checks, or passes unit tests. State
   plainly what was and was not verified live.

3. **Security is foundational.** Tenant data isolation and object-level authorization are
   verified on every change that touches auth, tenancy, or data access — not deferred.

4. **Honesty over completion.** Label unverified work as unverified. Surface assumptions,
   gaps, and things that could not be confirmed rather than papering over them. Never
   declare work sound if the mandated process was bypassed.

5. **Requirements-driven.** The live SPA is the baseline we scale from. Prior implementation
   artifacts (including the local Next.js rebuild) are references to evaluate on merit, not
   mandates. External/personal logistics are not design inputs unless raised.

6. **Nothing is deferred without a record and a pick-up condition.** Every conscious
   decision to not-do-something-now — deferral, parked decision, accepted risk, or known
   bug — gets a row in `docs/DEFERRED_REGISTER.md` **in the same commit that creates it**,
   with why it was deferred and a concrete pick-up trigger (a date, an event, or both).
   "Later" is not a pick-up condition. Rows are closed, never deleted; closure cites the
   commit and states what was verified live. Dropping or changing a deferral is itself a
   recorded decision with written justification. Review the register at every phase exit —
   no phase exits with an open row targeted at that phase unless it is explicitly
   re-targeted with justification. A deferral that is silently forgotten is the
   documentation-deficit failure this product exists to diagnose (framework areas PO-03,
   PO-07); we do not get to commit it ourselves.

   **This governs deferred *process*, not only deferred work.** A skill whose trigger has
   fired and which is not run immediately is a conscious not-now decision, and takes a
   register row on exactly the same terms — justification and pick-up trigger, in the same
   commit. A todo item is **not** sufficient: todos are session-local and evaporate, leaving
   no trace for anyone to audit. That gap is how `security-review` was rescheduled past the
   very change it existed to gate on 2026-08-02 — deferring the process cost nothing and
   left nothing behind, while deferring the work would have required writing down why.

7. **Design systems, not components.** Before building or changing anything, state what
   each part is *responsible for* and how it *interacts with the rest* — separation of
   concerns and clean abstractions are requirements, not aspirations. A helper that does
   three things with no stated boundary is a design defect even when it works. Two
   questions are mandatory and must be answered in writing:
   (a) *what is this unit's single responsibility, and what is explicitly not its job?*
   (b) *how does it interact with every layer it touches, including the ones it doesn't
   call directly?* Most defects on this project have been interaction defects, not
   component defects: rate limiting works but its in-memory store breaks under
   multi-instance hosting; logout works but a JWT decision elsewhere makes it
   unrevocable; `orgDb` was specified as "inject orgId **and** enforce role **and** set
   the GUC" — three concerns in one helper — which is why it was ambiguous whether it
   filtered at all. Components verified in isolation compose into a broken system.
   Architectural decisions get an ADR in `docs/adr/` recording context, options,
   decision, and consequences.

8. **Verify, do not transcribe.** Any claim inherited from another document — a bug
   list, a prior design, a status table — is a hypothesis until re-checked against the
   running code. Four of the eight Phase-0 bug rows copied into
   `docs/DEFERRED_REGISTER.md` were already fixed when copied. Cite the file and line,
   or the command and its output, for load-bearing claims.

9. **Subagents are bound by these rules, not exempt from them.** A dispatched implementer or
   reviewer is doing this project's work and is held to this project's standards. The
   controller does not get to launder a shortcut by delegating it. Concretely:

   (a) **Every dispatch carries the process, not just the task.** The dispatch prompt must
   require the subagent to scan `docs/SKILLS_INVENTORY.md` and invoke the fitting skill
   *before* writing code — the same rule 1 obligation the controller has. Hand-feeding a
   brief and a constraints list is not a substitute: it tells the subagent *what* to build
   while silently exempting it from *how* this project builds.

   (b) **Nothing is written outside the assigned scope.** Files belonging to another task
   are not the subagent's to create, even as a head start.

   (c) **Everything written is committed or declared.** Review packages are built from
   `git diff`, so an untracked file is structurally invisible to every reviewer. During the
   2026-08-02 rollback, `scratch-probe.ts`, `scratch-probe2.ts` and a complete uncommitted
   `__tests__/integration/isolation.test.ts` were found in the tree — none had ever appeared
   in a review package, and none were mentioned in any report. A subagent that leaves the
   tree dirty has bypassed review whether or not it intended to.

   (d) **The controller verifies the tree, not just the diff.** `git status --porcelain
   --untracked-files=all` after every task; untracked residue is a finding, not noise.

   (e) **Reports are evidence, not assurances.** A subagent states what it ran and what the
   output was. Rule 4 binds subagents exactly as it binds the controller.

## Decisions locked (see docs/VISION_AND_PLAN.md §3)
- Primary adopter: **team self-improvement**.
- Standards: **ISO/IEC 42001** + **African Union Continental AI Strategy (2024)** / **UNESCO EIA**.
