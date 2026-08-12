# Triage of the 48 open rows labelled "Phase 1d"

**Date:** 2026-08-12, immediately after Phase 1d-i closed
**Status:** v2 — v1 was BLOCKED by adversarial review (3 criticals). See §1.
**Method:** three groupings from three different search roots, per AGENTS.md §3

> **Completeness is checked mechanically, not by reading.** v1 claimed 48 rows and enumerated
> 47; the rewrite of v2 then dropped two more, including the one row v1 was credited with
> finding. Both were caught by diffing the row IDs named in this file against the 48 extracted
> from the register — never by re-reading. Run it after any edit:
> ```
> comm -23 <(all 48 open rows targeted 1d, sorted) <(grep -oE 'D-[0-9]{3}' this-file | sort -u)
> ```

---

## 1. Why this is v2

v1 grouped the 48 rows two ways and reported three disagreements between the groupings. An
independent adversarial pass on the decomposition returned **BLOCK** with three criticals, all
verified by the controller before acting:

**C1 — the seven groups enumerated 47 rows, not 48.** `5+5+12+5+6+10+4 = 47`. Each group's
stated count matched its own contents, so the shortfall was invisible from inside the table.
The missing row was **D-163**, and it is the row v1's only actionable instruction detonates:
v1 said "resolve D-109 first", D-109 is "`prisma migrate dev` cannot generate a migration on
this branch", and D-163's trigger is *"before anyone next runs a real `prisma migrate dev`"*.
Fixing one arms the other.

**C2 — v1 filed D-207 in a group it told the reader to skip, and D-207 invalidates v1's own
step 2.** D-185's proof obligation names a deterministic probe at
`.superpowers/sdd/.../task-7-artifacts/d185-probe.spec.ts`. That workspace was deleted at the
Phase 1d-i close and the probe was never committed — `git log --all -- '*d185-probe*'` is
empty. **The controller destroyed it.** The pre-deletion citation check counted FILES rather
than occurrences, so `docs/DEFERRED_REGISTER.md`'s seven citations registered as one hit and
D-185's two were inside a file already ticked off. Recorded in D-185 with the reconstruction
recipe; the loss is permanent.

**C3 — v1's completion condition was satisfiable without fixing anything.** v1 said the phase
is done when "the quarantined test can be un-quarantined", and called that checkable rather
than a matter of judgement. D-185's own text says otherwise: *"if it is 1, this specific
trigger cannot fire in CI and the quarantine may be liftable **ahead of the product fix**."*
The bug's trigger is React StrictMode's dev-only double-mount; CI runs a production build where
that is compiled out. So a **measurement** turns the condition green with the data-loss bug
shipped. That is D-191's own class — the check sits on a neighbouring surface and passes while
the property is violated — committed inside a phase named for trustworthiness.

**The structural cause, which is why v2 changes root rather than adding a group:** all seven of
v1's groups were **harm-kinds**. Both of its lenses sorted by consequence. A row whose harms
differ while its cause is single therefore splits across three groups, and a row blocked on an
unmade decision reads as schedulable.

---

## 2. Grouping 3 — root: *what is each row waiting on?*

Generated from the register's own **Pick-up trigger** column, which neither earlier grouping
read. This is the root the review identified, and it surfaces in one pass what the other two
missed entirely.

### 2.1 The finding: 15 rows are OVERDUE, not deferred

Fifteen rows carry a pick-up trigger naming an event that **has already happened**:

| Row | Its trigger says | That event |
|---|---|---|
| D-023, D-025 | "Phase 1 UI pass" | Phase 1 is closing now |
| D-028 | "Phase 1 report/PDF port" | done |
| D-049 | "Before any UI ports in Plan 1b" | Plan 1b merged `3faf328` |
| D-051 | "Plan 1b route port" | merged |
| D-080 | "Before Plan 1b wires its first route that passes request-derived values into a Prisma `where`" | merged |
| D-089 | "Plan 1b, at the task that creates `requireOrgContext`" | merged |
| D-096 | "When Plan 1b ports its first route" | merged |
| D-109 | "Before Task 3 or any later task needs `migrate dev --create-only`" | passed |
| D-135 | "or at the start of Phase 1c" | Plan 1c merged `8c5c32b` |
| D-145 | re-targeted at Task 10 fix round 1 | done |
| D-149 | "Before Plan 1c's C6 phase exit" | that exit ran |
| D-155, D-162, D-164 | "Task 10 (the attach UI)" | Task 10 shipped |

**These are not scheduling decisions awaiting a moment. They are moments that passed unnoticed.**
Each needs one of three dispositions, decided per row against current code: silently done
already (close with evidence), still true (re-trigger against something that has not happened
yet), or obsolete (close as superseded).

**This is D-133's own subject** — *"Register drift is bound to TASK completion, not CONTROLLER
completion"* — which is itself one of the 48, and which predicted exactly this accumulation.

### 2.2 Armed traps: fixing one row fires another

| Fixing | Arms | Because |
|---|---|---|
| D-109 (make `migrate dev` runnable) | **D-163** | D-163's trigger is running `migrate dev`; the diff it produces proposes `DROP INDEX "evidence_dedup_key"`, reintroducing the duplicate-evidence defect that constraint prevents |
| D-199 (stop trusting `x-forwarded-for`) | the e2e fixture | Recorded in D-199 during Phase 1d-i: 20 seats spoof per-seat headers against a login cap of 15 |

Armed traps must be scheduled **as pairs, in one commit**, never as neighbouring tasks.

### 2.3 Blocked on a decision nobody has made

- **D-169** — *"A human partner decision on whether to add jsdom plus `@testing-library/react`… explicitly NOT proposed or decided here."*
- **D-107** — *"Decide the product rule first, then enforce it."*
- **D-206** — *"Write it, or drop it with reasons stated."*

v1 made D-169 **step 1** of its recommended phase while deferring the security group on exactly
this property. A team cannot start a phase whose first step needs a decision that has not been
taken.

### 2.4 Blocked on deployment (D-018 hosting)

D-125, D-199, D-200. **Three rows, not the twelve v1 implied** — v1 deferred a 12-row group on
"several are gated on D-018", and per-row targets show only two carry that gate explicitly.

### 2.5 Waiting on first real users

D-104, D-105, D-130, D-167, D-177, D-201. Note **D-130's own trigger says "fix both together"
with D-104** — v1 scheduled D-130 and excluded D-104.

### 2.6 Opportunistic — fires when someone next touches a named file

D-155, D-162, D-164, D-166, D-170, D-178, D-180, D-182, D-186, D-187, D-198. These are cheap
**if and only if** they ride along with work already opening that file. Scheduled alone they
cost a context-load each.

### 2.7 Chained triggers — waiting on another row, not an event

- **D-050** — *"Read it at D-049 pick-up"*. D-049 is itself overdue (§2.1), so D-050 is
  transitively overdue. A 27 KB UX audit from 2026-07-02 that has never been read or factored
  into any decision. Its own row warns to *"verify its findings against current code before
  trusting any of them"* — the codebase has been substantially rebuilt since it was written.

### 2.8 Declared but never wired — the class, corrected twice

D-177, D-178, D-180, D-182, **D-106**, and (outside this document's search root) **D-179**.

**D-106** — `MembershipStatus` carries values nothing ever sets, so suspension is filtered for
but never implemented — is the identical shape to the other four and was missed when the class
was first scoped at four members. Its trigger is *"whenever a member needs to be suspended
without being removed — the realistic trigger is an institution asking to freeze a departing
staff member's access"*, which places it in §2.5 (waiting on real users) as well.

**D-179** sits at Phase 2a. See §5.

### 2.9 Fires at the next phase exit

D-132, D-133, D-205 — and D-133 is the mechanism that would have caught §2.1.

---

## 3. What connects the rows

**A shared-cause group v1 could not produce** (the review's W1), because every v1 group was a
harm-kind: **the Prisma schema does not describe the live database.** Constraints were written
directly into `migration.sql` and never mirrored in `schema.prisma`'s DSL. One cause, three
consequences, filed by v1 into three different groups:

- **D-109** — tooling cannot generate migrations
- **D-163** — `migrate diff` proposes dropping the constraint
- **D-154** — `upsert` cannot target the constraint by name for its concurrency retry

D-163's own text asserts the link: *"consistent with D-154, which already names the same root
cause for a DIFFERENT consequence."* One fix closes all three. Scheduled apart, each pays for
the same investigation.

**A structural convergence, still valid from v1 but corrected to six rows:** D-185, D-130,
D-198, D-145 **and D-170** all live in `AssessmentPageClient.tsx` (890 lines) or its data flow.
v1 listed five and dropped D-170 with no reason given.

---

## 4. Recommendation

### 4.1 First: reconcile the 15 overdue rows. This is not a phase, it is a debt already incurred.

Reading and verification, no implementation. For each: is it silently done, still true, or
obsolete? The output is 15 dispositions with evidence.

**Why first:** it is cheap; it is a precondition for trusting any later scope decision (three of
the fifteen — D-080, D-096, D-101 — are security rows whose triggers fired during Plan 1b and
which may or may not still be true); and until it runs, every future phase-exit gate inherits a
register whose "Open" is not evidence of "outstanding".

### 4.2 Then: Phase 1d-ii, "the assessment client loses user work"

**Six rows, one component:** D-185, D-130, D-198, D-145, D-170 — plus **D-104**, because D-130's
own trigger says fix both together.

**Prerequisites that are not steps:**
- **D-169** needs a human decision before it can begin (§2.3). If the answer is no, every fix
  below is provable only through browser tests.
- **D-185's probe must be rebuilt as a committed test** (§1, C2).

**Completion condition, replacing v1's single unsound one — one obligation per row:**

| Row | What must be true |
|---|---|
| D-185 | The `:205` guard exists; the rebuilt probe fails before and passes after |
| — | The production-build assessment GET count is **measured and recorded**. This is what makes the quarantine liftable, and it is a measurement, not a fix — kept separate so it cannot be mistaken for one |
| D-130 | A `version`/`updatedAt` precondition on `respondToAssessment` and `completeAssessment`, with a test that fails against the current unconditional write |
| D-104 | Same mechanism, same test |
| D-198 | `autoSave` moved out of the updater at both sites |
| D-145 | Server error detail surfaced at the eight call sites, asserted |
| D-170 | Disposition recorded — fixed, or explicitly re-parked with a reason |

**Un-quarantining the browser test is NOT the completion condition.** It is an outcome of the
measurement, and v1's error was treating it as proof of the repair.

### 4.3 Deliberately not scheduled

- **Schema-vs-database (D-109, D-163, D-154)** — a real group, but D-109's fix arms D-163, so it
  needs its own scope where the pair lands together.
- **Pre-auth abuse chain (D-199, D-200, D-107, D-201, D-125)** — the review's W5. **D-201's harm
  is irreversible** (a squatted institution slug cannot be freed; soft-delete does not release
  the UNIQUE). No row in §4.2 is irreversible. This is a phase candidate ahead of or alongside
  1d-ii, and it was v1's largest misjudgement: deferred on a gating property two of twelve
  members have.
- **UI and design** — except D-023 and D-025, which are usability failures for dark-mode users,
  not documentation debt, and should be re-targeted as such.
- **Harvest classification (D-034, D-035, D-051, D-089)** — v1 proposed closing these as
  obsolete. **Do not**, yet: D-137 (a `DECISION` row at Phase 2a) states *"four harvest-audit
  rows depend on its outcome"*, almost certainly these. Resolve D-137 first.

---

## 5. Carried from the review, not yet acted on

- **D-179** is at Phase 2a and is a sixth member of the declared-but-never-wired class
  (`FrameworkVersion.status` has no production writer). The class is at least six, one already
  in the next phase. This document's own search root — rows targeted "Phase 1d" — structurally
  cannot see it.
- **Six rows carry dual targets** (D-051 "1d / Phase 4"; D-163, D-164, D-166, D-167, D-168
  "1d or 2"; D-178 "1d, or with D-008"). Retiring the "Phase 1d" label leaves them reading "or
  2" with no first term. A rule is needed before the re-target sweep, or six rows resolve one
  way with no recorded justification.
- **Register vocabulary defects.** The `Kind` column runs six values (`RISK` 92, `DEFERRAL` 44,
  `BUG` 34, `PROCESS FAILURE` 18, `PARKED` 10, `DECISION` 9) while the register's own legend
  declares four, and `register-integrity.test.ts` has no `KNOWN_KINDS` check. The header's
  status vocabulary and the test's `KNOWN_STATUSES` disagree in both directions.
- **D-028** ("PDF output thin; report depth unreviewed") is a report-fidelity defect filed under
  "UI and design". The PDF is what an institution presents externally.
