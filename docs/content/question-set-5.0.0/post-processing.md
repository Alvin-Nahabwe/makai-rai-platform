# Question set 5.0.0, post-processing: proposed revision

Proposal status: approved. Base: d13be0c data/questionBank.json (sha256 18e39eb8f4e0cbfbffb79bd4da15fb38ccc0ac704b70fa13f3bb14813e66b009).

28 questions in v0.5.0, 23 proposed: keep 23, reword 0, merge 5, cut 0, replace 0.

| Id | Kind | Action | Reason | New stem or survivor |
|---|---|---|---|---|
| Q-PO-01 | practice | keep | Monitoring for drift and degradation; feeds MC-28 (worked example 7). |  |
| Q-PO-02 | practice | keep | Triggers and steps for retraining; feeds MC-28. |  |
| Q-PO-03 | practice | keep | Human review and override of the system's outputs, the core oversight practice. |  |
| Q-PO-04 | practice | keep | Named roles and responsibilities for outcomes. |  |
| Q-PO-05 | practice | keep | A plan for responding when the system produces harmful outputs. |  |
| Q-PO-06 | practice | keep | Training for end-users; a different practice from whether the outputs themselves can be understood (Q-PO-07). |  |
| Q-PO-07 | practice | keep | Survivor of Q-PO-EXTRA-03. Kept apart from Q-PO-15 (10.1.9 pair): this asks whether end-users can read each output, its confidence and limits; Q-PO-15 whether the limits and intended use were told to everyone. Gains PO-02. |  |
| Q-PO-16 | practice | keep | Staged rollout before full deployment is a distinct practice. |  |
| Q-PO-17 | practice | keep | Survivor of Q-PO-EXTRA-01: monitoring fairness in production is per-group monitoring. Gains PO-06. |  |
| Q-PO-18 | practice | keep | Thresholds for stopping or flagging the system. Merging into Q-PO-01 was considered and rejected: stopping the system is a different decision from watching it. |  |
| Q-PO-19 | practice | merge | Near-duplicate of Q-PO-10 (10.1.9): infrastructure requirements and dependencies are part of the deployment specifications Q-PO-10 asks for. Both map PO-07 only. | Merged into Q-PO-10 |
| Q-PO-08 | practice | keep | Feedback channels for affected communities and end-users. |  |
| Q-PO-09 | practice | keep | Contesting or appealing a decision is a right distinct from giving feedback (Q-PO-08). |  |
| Q-PO-10 | practice | keep | Survivor of Q-PO-19: its expected practice will name infrastructure and dependencies such as power, connectivity and devices (W7). |  |
| Q-PO-11 | checklist | keep | Checklist kept (OD-09); the option 'Compliance with national data protection laws' keeps its text (10.1.6). |  |
| Q-PO-12 | practice | keep | Performance across the places, languages and cultures where the system is used; a different check from fairness monitoring over time (Q-PO-17). |  |
| Q-PO-13 | practice | keep | One of two questions on PO-05 Environmental Impact; its expected practice says how to estimate compute and energy (CG-04). |  |
| Q-PO-14 | practice | keep | Survivor of Q-PO-EXTRA-04: failing safely on out-of-distribution inputs needs those inputs to be detected. Gains PO-01 and PO-03. |  |
| Q-PO-15 | practice | keep | Telling stakeholders the limits and intended use; feeds MC-27. See Q-PO-07. |  |
| Q-PO-20 | practice | keep | Survivor of Q-PO-EXTRA-02: involving representatives of the people affected in design and evaluation is the outside review that follow-up asked for. Gains PO-02. |  |
| Q-PO-21 | practice | keep | Effect on existing workflows and professional practice. |  |
| Q-PO-22 | practice | keep | Allow-listed by id (AL-7); stays the team's own statement (worked example 8). |  |
| Q-PO-23 | practice | keep | Periodic review of whether the system is still appropriate; a different practice from continuous monitoring (Q-PO-01). |  |
| Q-PO-24 | practice | keep | Equity of access to the services the system supports. |  |
| Q-PO-EXTRA-01 | follow-up | merge | Follow-up asking for the same monitoring as Q-PO-17 (10.1.9): monitoring fairness in production means tracking results per group. Q-PO-17 gains PO-06. | Merged into Q-PO-17 |
| Q-PO-EXTRA-02 | follow-up | merge | Follow-up built on the team-diversity rating of Q-PP-06, which goes (OD-C3). Outside review by the people affected is Q-PO-20; outside boards and third-party reviews are options of Q-PO-11; missing perspectives are brought in by Q-PP-24. Q-PO-20 gains PO-02. | Merged into Q-PO-20 |
| Q-PO-EXTRA-03 | follow-up | merge | Follow-up asking for explanations shown with each output, which is one way of making outputs understandable to end-users (Q-PO-07); asked of every system it would exceed W3 where outputs need no explanation. Q-PO-07 gains PO-02. Q-PO-07's expected practice keeps the practice: in proportion to the risk, where an output is about a person, the user can see the main reasons for it. | Merged into Q-PO-07 |
| Q-PO-EXTRA-04 | follow-up | merge | Follow-up asking for detection of unusual production inputs and a fail-safe, which is what failing safely on out-of-distribution inputs (Q-PO-14) needs. Q-PO-14 gains PO-01 and PO-03. | Merged into Q-PO-14 |

## Document fields re-pointed in this stage

No document field is re-pointed in this stage.

## Proposed decisions

**OD-08.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D2 option A): none of the six follow-up questions stays a question of its own. Each is merged into the question of its stage that already asks the same practice, which takes the union of both mappings: Q-IP-EXTRA-01 into Q-IP-04, Q-IP-EXTRA-02 into Q-IP-08, Q-PO-EXTRA-01 into Q-PO-17, Q-PO-EXTRA-02 into Q-PO-20, Q-PO-EXTRA-03 into Q-PO-07, Q-PO-EXTRA-04 into Q-PO-14. The mechanism of FR-CNT-06 is built as written (OD-22 (a)): no unlock rules, every question shown to every team, Q-IP-06 always shown. With no follow-up kept, the QC-06 help-text rule applies to no question. This departs from revision 0.5's starting point (always show the follow-ups).

**OD-09.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D3 option A): keep the gate and all five checklists, each recorded as one decision (FR-CNT-03, FR-CNT-04 as built, OD-22 (a)). The gate Q-PP-GATE-SENSITIVE stays a scope answer (yes, no, not sure) that raises no finding and decides whether Q-PP-13 and Q-PP-14 apply. The checklists Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13 and Q-PO-11 keep their stems and options; Q-IP-06 absorbs Q-IP-05, because a checklist's status already records which measures fit the project.

**OD-C3.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D1 option A): Q-PP-06 is replaced by the practice question of worked example 2 under the new id Q-PP-24, mapped like Q-PP-06 (PP-03, PP-04), in Q-PP-06's place. Under R-61 a rewording that changes what done means takes a new id; R-61 is not set aside. Its why-this-is-asked text names C-20 Multi-stakeholder Consultation (CG-19).

Batch hash (question-set:post-processing, SHA-256 of the canonical JSON of its 23 approved stems): `11098ba94ebfe3431e1f5ae83a0b44a8e7b721fd305af6f0ef5efa9089540802`
