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

## Decisions locked (see docs/VISION_AND_PLAN.md §3)
- Primary adopter: **team self-improvement**.
- Standards: **ISO/IEC 42001** + **African Union Continental AI Strategy (2024)** / **UNESCO EIA**.
