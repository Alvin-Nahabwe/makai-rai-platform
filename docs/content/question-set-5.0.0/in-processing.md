# Question set 5.0.0, in-processing: proposed revision

Proposal status: approved. Base: d13be0c data/questionBank.json (sha256 18e39eb8f4e0cbfbffb79bd4da15fb38ccc0ac704b70fa13f3bb14813e66b009).

26 questions in v0.5.0, 22 proposed: keep 22, reword 0, merge 4, cut 0, replace 0.

| Id | Kind | Action | Reason | New stem or survivor |
|---|---|---|---|---|
| Q-IP-01 | practice | keep | Why this architecture fits the problem and the data; feeds MC-04. Absorbing Q-IP-09 and Q-IP-23 was considered and rejected: its stem does not ask whether a simpler model is enough. |  |
| Q-IP-02 | practice | keep | Whether training, validation and test data come from the same population is a distinct check; feeds MC-17. |  |
| Q-IP-03 | practice | keep | Overall measures from the confusion matrix; feeds MC-18. |  |
| Q-IP-04 | practice | keep | Survivor of Q-IP-EXTRA-01: performance per subgroup is the same analysis (worked example 5). Gains IP-04; feeds MC-19. |  |
| Q-IP-05 | practice | merge | Q-IP-06 asks which fairness measures were computed, and a checklist is done only when every option relevant to the project is ticked and every unticked one is explained (10.1.3): that is the choice of measures Q-IP-05 asks for. MC-20 is re-pointed to Q-IP-06's reason. | Merged into Q-IP-06 |
| Q-IP-06 | checklist | keep | Checklist kept and now shown to everyone (OD-08, OD-09). Survivor of Q-IP-05, so its reason carries why these measures and the team's own thresholds. Gains IP-01 in gaps, the literal union; a checklist with gaps is new in 5.0.0 (every v0.5.0 checklist maps only through its options, CG-02), and the pairs are unchanged because every option already maps IP-01. Feeds MC-20. |  |
| Q-IP-07 | practice | keep | Explainability methods used by the team; a different practice from end-users understanding outputs (Q-PO-07). |  |
| Q-IP-08 | practice | keep | Survivor of Q-IP-EXTRA-02: sensitivity to faults in the input data is robustness to noise. Gains IP-03 and IP-06; feeds MC-26; its expected practice names robustness methods (CG-03). |  |
| Q-IP-16 | practice | keep | A simple baseline is the concrete comparison that makes a reported measure meaningful; a different practice from choosing the model (Q-IP-09). |  |
| Q-IP-17 | practice | keep | Reliance on spurious correlations is a distinct check. |  |
| Q-IP-18 | practice | keep | Uncertainty and calibration as a practice; Q-IP-13 lists calibration only as one method. Its help text needs rewriting (FR-PUB-01). |  |
| Q-IP-09 | practice | keep | Survivor of Q-IP-23: seeking the simplest model that performs well enough is the performance and interpretability trade-off (10.1.9). |  |
| Q-IP-10 | practice | keep | Recording hyperparameters, seeds and settings. Merging with Q-IP-21 was considered and rejected: writing settings down and keeping versions are checked differently. |  |
| Q-IP-11 | practice | keep | Integrity checks through the data pipeline; one of three questions on IP-07, a thin area. |  |
| Q-IP-12 | practice | keep | The only question on the model card itself; feeds MC-29. |  |
| Q-IP-13 | checklist | keep | Checklist kept (OD-09); feeds MC-18. |  |
| Q-IP-14 | practice | keep | Aggregation bias, whether one model hides differences between populations, is a different question from measuring results per group (Q-IP-04). |  |
| Q-IP-15 | practice | keep | Bias introduced by tuning; feeds MC-24. |  |
| Q-IP-19 | practice | keep | How the model's errors fall on different groups, the consequence rather than the measure (Q-IP-04); feeds MC-22. |  |
| Q-IP-20 | practice | keep | Written limits and failure modes; feeds MC-11 and MC-26. |  |
| Q-IP-21 | practice | keep | Version control for code, pipelines and models; see Q-IP-10. |  |
| Q-IP-22 | practice | keep | Adversarial weaknesses; one of three questions on IP-07; its expected practice names robustness methods (CG-03). |  |
| Q-IP-23 | practice | merge | Near-duplicate of Q-IP-09 (10.1.9): weighing performance against interpretability is how the simplest model that performs well enough is chosen. Both map IP-03 only. | Merged into Q-IP-09 |
| Q-IP-24 | practice | keep | Whether the model holds up on data from other periods; a different check from whether the training data is current (Q-PP-20). |  |
| Q-IP-EXTRA-01 | follow-up | merge | Follow-up asking for the same per-subgroup evaluation as Q-IP-04 (worked example 5: one analysis answers both). MC-19 keeps Q-IP-04 and its typed table; the second source is dropped. | Merged into Q-IP-04 |
| Q-IP-EXTRA-02 | follow-up | merge | Follow-up whose sensitivity analysis, adding noise or quality faults to inputs and measuring the change, is a robustness test of the kind Q-IP-08 already asks for (noise). Q-IP-08 gains IP-03 and IP-06. | Merged into Q-IP-08 |

## Document fields re-pointed in this stage

| Document | Field | Label | Old source | New source | Sources after the re-point |
|---|---|---|---|---|---|
| model_card | MC-19 | Disaggregated performance (subgroup x metric table) | Q-IP-EXTRA-01 | typed only | typed; Q-IP-04 status, evidence |
| model_card | MC-20 | Fairness metrics with the team's own threshold | Q-IP-05 | Q-IP-06 | typed; Q-IP-06 reason; Q-IP-06 options |

## Proposed decisions

**OD-08.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D2 option A): none of the six follow-up questions stays a question of its own. Each is merged into the question of its stage that already asks the same practice, which takes the union of both mappings: Q-IP-EXTRA-01 into Q-IP-04, Q-IP-EXTRA-02 into Q-IP-08, Q-PO-EXTRA-01 into Q-PO-17, Q-PO-EXTRA-02 into Q-PO-20, Q-PO-EXTRA-03 into Q-PO-07, Q-PO-EXTRA-04 into Q-PO-14. The mechanism of FR-CNT-06 is built as written (OD-22 (a)): no unlock rules, every question shown to every team, Q-IP-06 always shown. With no follow-up kept, the QC-06 help-text rule applies to no question. This departs from revision 0.5's starting point (always show the follow-ups).

**OD-09.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D3 option A): keep the gate and all five checklists, each recorded as one decision (FR-CNT-03, FR-CNT-04 as built, OD-22 (a)). The gate Q-PP-GATE-SENSITIVE stays a scope answer (yes, no, not sure) that raises no finding and decides whether Q-PP-13 and Q-PP-14 apply. The checklists Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13 and Q-PO-11 keep their stems and options; Q-IP-06 absorbs Q-IP-05, because a checklist's status already records which measures fit the project.

**OD-C3.** Settled by the owner, 5 Nov 2026 12:23 EAT (sitting 1, verbatim "Accept as proposed", D1 option A): Q-PP-06 is replaced by the practice question of worked example 2 under the new id Q-PP-24, mapped like Q-PP-06 (PP-03, PP-04), in Q-PP-06's place. Under R-61 a rewording that changes what done means takes a new id; R-61 is not set aside. Its why-this-is-asked text names C-20 Multi-stakeholder Consultation (CG-19).

Batch hash (question-set:in-processing, SHA-256 of the canonical JSON of its 22 approved stems): `fa78660124564f2cd8bc7bfb38f89b1ea066da3aaa4dd6016fd478cc244a46fa`
