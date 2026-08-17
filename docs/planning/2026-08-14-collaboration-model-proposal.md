# Collaboration model — human partner's proposal, and the evidence tested against it

**Date:** 2026-08-14
**Status:** PROPOSAL. Not decided. Two open questions at the end block design.
**Why this file exists:** the proposal and the evidence supporting it existed only in
conversation. Recorded before compaction so neither has to be rediscovered.

---

## 1. The proposal, as stated by the human partner

**Roles.** Drop `reviewer` and `viewer` as organisation roles; they become *actions*.
`assessor` becomes `member`.

- Someone invited by an org owner or admin joins as a **member**, with **view-only** access to
  existing projects and their assessments.
- A member becomes an **assessor** by registering a project to assess.
- An org owner, org admin, or project owner can upgrade any existing org member to **assessor of
  a project**, or **reviewer of a project's assessments**.

So `assessor` and `reviewer` move from org-wide roles to **per-project grants**.

**Concurrency.** Only one person may fill or review a project assessment at any one time.

**The reasoning, verbatim in substance:** the assessment engine is sequential — early questions
affect later ones — so two people cannot work in parallel unless they are in the same section,
which is precisely what causes the corruption. Merging is an extra complex layer we probably
cannot afford to explore now. One ongoing project assessment or review at a time is reasonable.
These are teams; they can communicate who is working on what and when, and that is not for the
system to enforce.

**The compensating control.** Because only one person works at a time, the platform needs a
strong, detailed, transparent, foolproof, easy-to-follow assessment and review audit trail:
who did what, when, and what changed — so teams can track their own work.

---

## 2. Evidence gathered testing the proposal

### 2.1 The sequential claim is TRUE, and stronger than stated — the coupling is in SCORING

A first measurement understated it. Counting question gating alone:

- 78 questions total
- 3 gated on an earlier answer within a stage
- 6 gated across stages

That is ~12%, which would have made "different people, different sections" *mostly* safe.

**The real coupling is weights, not visibility.** `data/scoringConfig.json`'s
`crossStageWeights` holds **12 rules** in which an AREA SCORE in one lifecycle stage modifies
the WEIGHTS of named questions in a later stage, capped at 2.0x, combined with
`overlapStrategy: max`:

```
pre_to_in   (6 rules)   areaScore PP-02 -> Q-IP-04, Q-IP-05, Q-IP-06
                        areaScore PP-03 -> Q-IP-04, Q-IP-14, Q-IP-19
                        areaScore PP-04 -> Q-IP-02, Q-IP-04
                        areaScore PP-06 -> Q-IP-12
in_to_post  (4 rules)   areaScore IP-01 -> Q-PO-09, Q-PO-17
                        areaScore IP-03 -> Q-PO-07, Q-PO-10
                        areaScore IP-05 -> Q-PO-05, Q-PO-16, Q-PO-18
                        areaScore IP-06 -> Q-PO-04, Q-PO-19
pre_to_post (2 rules)   areaScore PP-04 -> Q-PO-09, Q-PO-12
                        areaScore PP-06 -> Q-PO-14
```

**Consequence: there are no independent sections.** When one person answers pre-processing
questions, they change what another person's in-processing and post-processing answers are
WORTH. A team splitting the work by expertise is not parallelising; it is two people mutating a
shared scoring graph, and neither can observe the other's effect on their own results.

**This also raises the cost of the merge option the proposal rejects.** A merge would have to
reconcile not two answer sets but two SCORING GRAPHS, and because `overlapStrategy` is `max`
over multiple modifiers, the merged result can differ from both inputs. There is no defensible
automatic resolution. Refusing to explore merging now is well-founded.

### 2.2 The concurrency defects, reproduced

**Race 1 — completion vs autosave. Narrowed, not closed.** `lib/data/assessments.ts:105-116`
already documents this race and says it was fixed by moving the read, score computation and
write into ONE `withOrg` transaction. That fix is real but insufficient: `tenant.ts:209` opens
the transaction with **no isolation level**, so it runs at the database default, confirmed
`read committed`. Wrapping a read and a write in one transaction does not make them atomic
against a concurrently COMMITTED write; it shrinks the window from two round-trips to one
transaction's duration.

Reproduced against the real dev database with two interleaved sessions:

```
setup:            engine_state=answers_v1, report_data=NULL
t=1s  session B:  UPDATE engine_state = 'answers_v2_user_typed_more'   COMMIT
t=3s  session A:  UPDATE report_data = 'report_derived_from_answers_v1' COMMIT

FINAL: engine_state=answers_v2_user_typed_more
       report_data=report_derived_from_answers_v1
```

Both committed. No error, no conflict, nothing lost. The row holds current answers and a report
computed from answers already replaced — and that report is the artifact an institution
presents externally.

**Race 2 — autosave vs autosave. Wide open, and a genuine lost update.**
`respondToAssessment` (`lib/data/assessments.ts:87`) does `data: { engineState }` — a **blind
whole-blob replace**. It never reads the existing state and merges, and the client PATCHes the
entire engine state on every debounced save. Last writer wins; the other person's answers are
gone with no error and no log entry.

### 2.3 Access is org-scoped, not creator-scoped

`lib/data/assessments.ts` contains **no `userId` filtering at all**. RLS filters by `orgId`
only; the `userId` column records who started an assessment and nothing enforces it afterwards.
Three roles hold `assessment:respond` and `assessment:complete` — owner, admin, assessor. So
today, any of those three can edit any assessment in the organisation, concurrently, with no
presence indicator, no lock, and no conflict signal anywhere in the assessment UI.

**This supports the per-project-grant half of the proposal:** the current model grants far more
than the work requires.

---

## 3. Where the proposal needs more than it currently says

### 3.1 The lock does NOT fix D-185, so Phase 1d-ii does not dissolve into this

Single-writer means one PERSON. D-185's reproduced bug is one person with **two browser tabs** —
a stale fetch response from tab A overwriting state in tab B. Same user, same permission, same
lock holder. Unless the lock is per-SESSION rather than per-user, that defect survives untouched.

D-185, D-198, D-145, D-169 and D-170 remain real work regardless of the collaboration model.
D-104 and D-130 change shape under it and should be re-targeted into the new phase.

### 3.2 Lock lifecycle is unspecified, and is where these designs usually fail

A lock is easy to take and hard to release. Browser closes, laptop sleeps, connectivity drops —
and ADR-0002 names *"shared lab machines and intermittent connectivity"* as the target context.
Without an answer to "what happens when the holder vanishes", the result is an assessment nobody
can edit, which is worse than the race it replaced.

### 3.3 A tension worth keeping explicit

The proposal says the system enforces single-writer AND that coordination is not for the system
to enforce. These are compatible, and the line matters: **the system enforces mutual exclusion;
humans negotiate turn-taking.** But that requires the system to make the current holder VISIBLE,
or humans cannot negotiate what they cannot see.

### 3.4 It is a data-model change, and a hard-to-reverse one

Per-project grants need project-level membership. `OrgRole` is a Postgres enum with existing
rows. That is a migration — and D-109 records that `prisma migrate dev --create-only` is broken
on this branch. AGENTS.md §2 makes `what-if-oracle` MANDATORY at forks of exactly this kind
(tenancy, identity, data model). It has not been run.

### 3.5 The audit trail becomes a functional dependency, not a compliance item

Under single-writer, the audit trail is the ONLY remaining way a team sees its own work: if one
person holds the assessment, everyone else's view of progress IS the log. D-105 already records
that this platform has no tenant-scoped audit trail, for a tool aligned to ISO/IEC 42001. The
proposal converts that from a compliance gap into a dependency of the collaboration model.

---

## 4. Open questions blocking design

1. **Does the lock cover reviewing as well as filling?** If an assessor is filling and a
   reviewer wants to review, is that blocked? Reviewing is presumably read-plus-annotate. One
   lock or two changes the model.
2. **What happens when the holder disappears?** Heartbeat with timeout, explicit release, or
   owner/admin force-takeover. See §3.2 — this is the failure mode, not a detail.

## 5. Recommended shape, pending those answers

- This is **its own phase**, not Phase 1d-ii: a role restructure, a locking mechanism, and an
  audit subsystem. Together larger than everything Phase 1d-i delivered.
- **Phase 1d-ii shrinks** to what holds regardless: D-169, D-185, D-198, D-145, D-170.
- **D-130 and D-104 re-target** into the new phase, since single-writer changes what fixing them
  means.
- Run `what-if-oracle` on the fork before designing (§3.4), and `adversarial-reviewer` on the
  decomposition before it reaches the human partner — self-review is 0-for-8 on decompositions
  in this project; independent review is 8-for-8.
