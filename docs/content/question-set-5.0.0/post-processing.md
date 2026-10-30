# Question set 5.0.0, post-processing: proposed revision

Proposal status: draft. Base: d13be0c data/questionBank.json (sha256 18e39eb8f4e0cbfbffb79bd4da15fb38ccc0ac704b70fa13f3bb14813e66b009).

28 questions in v0.5.0, 23 proposed: keep 23, reword 0, merge 5, cut 0, replace 0.

| Id | Kind | Action | Reason | New stem or survivor |
|---|---|---|---|---|
| Q-PO-01 | likert-5 | keep | Monitoring for drift and degradation; feeds MC-28 (worked example 7). |  |
| Q-PO-02 | likert-5 | keep | Triggers and steps for retraining; feeds MC-28. |  |
| Q-PO-03 | likert-5 | keep | Human review and override of the system's outputs, the core oversight practice. |  |
| Q-PO-04 | likert-5 | keep | Named roles and responsibilities for outcomes. |  |
| Q-PO-05 | likert-5 | keep | A plan for responding when the system produces harmful outputs. |  |
| Q-PO-06 | likert-5 | keep | Training for end-users; a different practice from whether the outputs themselves can be understood (Q-PO-07). |  |
| Q-PO-07 | likert-5 | keep | Survivor of Q-PO-EXTRA-03. Kept apart from Q-PO-15 (10.1.9 pair): this asks whether end-users can read each output, its confidence and limits; Q-PO-15 whether the limits and intended use were told to everyone. Gains PO-02. |  |
| Q-PO-16 | likert-5 | keep | Staged rollout before full deployment is a distinct practice. |  |
| Q-PO-17 | likert-5 | keep | Survivor of Q-PO-EXTRA-01: monitoring fairness in production is per-group monitoring. Gains PO-06. |  |
| Q-PO-18 | likert-5 | keep | Thresholds for stopping or flagging the system. Merging into Q-PO-01 was considered and rejected: stopping the system is a different decision from watching it. |  |
| Q-PO-19 | likert-5 | merge | Near-duplicate of Q-PO-10 (10.1.9): infrastructure requirements and dependencies are part of the deployment specifications Q-PO-10 asks for. Both map PO-07 only. | Merged into Q-PO-10 |
| Q-PO-08 | likert-5 | keep | Feedback channels for affected communities and end-users. |  |
| Q-PO-09 | likert-5 | keep | Contesting or appealing a decision is a right distinct from giving feedback (Q-PO-08). |  |
| Q-PO-10 | likert-5 | keep | Survivor of Q-PO-19: its expected practice will name infrastructure and dependencies such as power, connectivity and devices (W7). |  |
| Q-PO-11 | checklist | keep | Checklist kept (OD-09); the option 'Compliance with national data protection laws' keeps its text (10.1.6). |  |
| Q-PO-12 | likert-5 | keep | Performance across the places, languages and cultures where the system is used; a different check from fairness monitoring over time (Q-PO-17). |  |
| Q-PO-13 | likert-5 | keep | One of two questions on PO-05 Environmental Impact; its expected practice says how to estimate compute and energy (CG-04). |  |
| Q-PO-14 | likert-5 | keep | Survivor of Q-PO-EXTRA-04: failing safely on out-of-distribution inputs needs those inputs to be detected. Gains PO-01 and PO-03. |  |
| Q-PO-15 | likert-5 | keep | Telling stakeholders the limits and intended use; feeds MC-27. See Q-PO-07. |  |
| Q-PO-20 | likert-5 | keep | Survivor of Q-PO-EXTRA-02: involving representatives of the people affected in design and evaluation is the outside review that follow-up asked for. Gains PO-02. |  |
| Q-PO-21 | likert-5 | keep | Effect on existing workflows and professional practice. |  |
| Q-PO-22 | likert-5 | keep | Allow-listed by id (AL-7); stays the team's own statement (worked example 8). |  |
| Q-PO-23 | likert-5 | keep | Periodic review of whether the system is still appropriate; a different practice from continuous monitoring (Q-PO-01). |  |
| Q-PO-24 | likert-5 | keep | Equity of access to the services the system supports. |  |
| Q-PO-EXTRA-01 | likert-5 | merge | Follow-up asking for the same monitoring as Q-PO-17 (10.1.9): monitoring fairness in production means tracking results per group. Q-PO-17 gains PO-06. | Merged into Q-PO-17 |
| Q-PO-EXTRA-02 | likert-5 | merge | Follow-up built on the team-diversity rating of Q-PP-06, which goes (OD-C3). Outside review by the people affected is Q-PO-20; outside boards and third-party reviews are options of Q-PO-11; missing perspectives are brought in by Q-PP-24. Q-PO-20 gains PO-02. | Merged into Q-PO-20 |
| Q-PO-EXTRA-03 | likert-5 | merge | Follow-up asking for explanations shown with each output, which is one way of making outputs understandable to end-users (Q-PO-07); asked of every system it would exceed W3 where outputs need no explanation. Q-PO-07 gains PO-02. | Merged into Q-PO-07 |
| Q-PO-EXTRA-04 | likert-5 | merge | Follow-up asking for detection of unusual production inputs and a fail-safe, which is what failing safely on out-of-distribution inputs (Q-PO-14) needs. Q-PO-14 gains PO-01 and PO-03. | Merged into Q-PO-14 |

## Document fields re-pointed in this stage

No document field is re-pointed in this stage.

Batch hash (question-set:post-processing, SHA-256 of the canonical JSON of its 23 approved stems): `11098ba94ebfe3431e1f5ae83a0b44a8e7b721fd305af6f0ef5efa9089540802`
