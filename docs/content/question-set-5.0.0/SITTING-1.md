# Sitting 1: the question set for content 5.0.0

For the product owner, Thursday 5 November 2026, afternoon. Prepared by C-TXT on branch `unit/c-txt` at commit `0d68128a` (rebased onto `release/0.6.0` at `0b992644`). Proposal status: **revised**, awaiting your decisions. Nothing in this pack has been approved yet.

You approve the question set one stage at a time. For each stage this pack shows what happens to every v0.5.0 question, the document fields that change, what the coverage check found, what the independent checker said, and the batch hash your approval signs. Your approval of a stage is recorded as a sign-off over that hash, with the approver "Product owner, MAK-AI" and the time you give it.

## Summary (one screen)

| Stage | v0.5.0 questions | Proposed | Keep | Merge | Replace | Reword | Cut | Fields re-pointed | Batch hash |
|---|---|---|---|---|---|---|---|---|---|
| pre-processing | 24 | 22 | 21 | 2 | 1 | 0 | 0 | 3 | `3996fee4a4e4` |
| in-processing | 26 | 22 | 22 | 4 | 0 | 0 | 0 | 2 | `fa7866012456` |
| post-processing | 28 | 23 | 23 | 5 | 0 | 0 | 0 | 0 | `11098ba94ebf` |
| all | 78 | 67 | | | | | | 5 | |

Coverage check: **pass** on all three stages (no failure; all 21 risk areas and all 28 controls are still reached; 283 question-control pairs of 315 remain because merged questions are gone, not because any area or control lost its last question).

**Disputed items: none.** The checker gave 25 verdicts (19 stands, 6 change). The proposer applied all 6 changes in the one revision and the checker's position was not contested, so nothing is left disputed between the agents.

**Questions only you can answer** (each is set out in full further down):

| # | Question | Stages whose hash it changes | Proposed answer |
|---|---|---|---|
| D1 | OD-C3: give the reworded team-perspectives question a new id (Q-PP-24), or keep the id Q-PP-06? | pre-processing | A: new id Q-PP-24 |
| D2 | OD-08: merge all six follow-up questions into the questions that already ask the same practice, or keep some as questions of their own? | in-processing, post-processing | A: merge all six |
| D3 | OD-09: keep the gate and the five checklists as built, folding Q-IP-05 into the checklist Q-IP-06? | in-processing | A: yes, as built, Q-IP-05 folded in |
| F1 | Should the data card keep field DC-31 "Datasheet held by the team", typed by the team? | none (field maps are not in the hash) | A: keep it, typed only |
| N1 | New since the check: Q-IP-20's question contains the word "failure", which the platform's banned-claims check now flags. Keep it (allowed by id) or reword it? | in-processing | none; your choice |
| N2 | New since the check: Q-PO-14's question contains "fail" ("fail safely"), flagged the same way. Keep it (allowed by id) or reword it? | post-processing | none; your choice |

**What to say.**

1. Answer the six questions first, because the stage hashes depend on them. "D1 to D3 and F1 as proposed" is enough if you accept those four. Answer N1 and N2 with "keep" or with the new wording.
2. Then, for each stage, either approve it or list changes:
   - To approve: **"I approve the pre-processing question set, batch hash 3996fee4."** (in-processing `fa786601`, post-processing `11098ba9`). Please give the time, or we record the time you said it.
   - To list changes: **"Pre-processing: change ..."**, one line per change, for example "Q-PP-05: merge into Q-PP-04", "Q-IP-EXTRA-02: keep as its own question", "Q-IP-20: reword to ...". We then apply the changes, re-run the coverage check, re-render the stage, and give you the new hash to approve.
3. The hashes above are only valid with the proposed answers. Any other answer to D1, D2, D3, N1 or N2 changes the hash of the stages named in the table, and you approve the new hash instead. For D1 option B the new pre-processing hash is already computed (see D1).

A changed wording that alters what "done" means for a question is a new question with a new id (rule R-61), not a reword. If you ask for one, we say so before you approve.

## The decisions that span stages

The spec's starting point for each decision is revision 0.5's recommendation (SRS line 3890): always show the follow-ups; one decision per checklist and a gate that raises no finding; reword `Q-PP-06`. The mechanism the platform builds for follow-ups, checklists and the gate stays as written in every option below (OD-22 (a)). If you want a different mechanism, that is a change to the spec, and we stop and come back to you before applying it.

### D1. OD-C3: the team-perspectives question (pre-processing)

- **Now (v0.5.0), Q-PP-06:** How diverse is the team working on the AI system, in terms of disciplinary backgrounds, gender, culture, and nationalities?
- **New wording (both options):** Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks?
- This is worked example 2's wording, word for word (SRS line 4040). The old question describes who is on the team, so it cannot be marked done; the new one asks for a practice a colleague can check. It maps to the same risk areas as before (PP-03, PP-04).
- **A (proposed, and the checker agrees):** replace Q-PP-06 with the new question under a new id, **Q-PP-24**. Rule R-61 gives a new id to any rewording that changes what done means, and this one does. Pre-processing hash `3996fee4a4e4b120f417151cdbeca27f08c954c19632a1e92d14156b5d1f1a20`.
- **B (revision 0.5's starting point):** reword Q-PP-06 and keep its id. This needs you to set rule R-61 aside for this one question. Pre-processing hash with B, computed the same way: `9589396c74732f35308dd9f240296c97c0bda16fcf724fa6a77515808c210567` (coverage check: pass).
- The proposal's own text: Proposed: replace Q-PP-06 with the practice question of worked example 2 under the new id Q-PP-24, mapped like Q-PP-06 (PP-03, PP-04). Under R-61 a rewording that changes what done means takes a new id, and this one does: the old stem asked how diverse the team is, the new one whether the team found and filled the perspectives the problem needs. Revision 0.5 proposed a reword that keeps the id Q-PP-06; keeping it would need your explicit choice to set R-61 aside for this question. Its why-this-is-asked text names C-20 Multi-stakeholder Consultation (CG-19).

**Your answer:** A or B.

### D2. OD-08: the six follow-up questions (in-processing and post-processing)

Revision 0.5's starting point was to show the follow-ups to every team. Shown to every team, each of the six asks a practice that another question of its stage already asks, and some were written to assume the team had fallen short earlier.

| Follow-up | Its question now | Proposed: merged into |
|---|---|---|
| Q-IP-EXTRA-01 | Have you performed disaggregated evaluation of model performance across demographic subgroups identified in your data? | Q-IP-04 |
| Q-IP-EXTRA-02 | Have you conducted sensitivity analysis to assess how data quality variations affect model predictions? | Q-IP-08 |
| Q-PO-EXTRA-01 | Have you implemented disaggregated monitoring for demographic subgroups post-deployment? | Q-PO-17 |
| Q-PO-EXTRA-02 | Have you established external review mechanisms to compensate for limited team perspective diversity? | Q-PO-20 |
| Q-PO-EXTRA-03 | Have you implemented runtime explanation generation or user-facing decision rationale features? | Q-PO-07 |
| Q-PO-EXTRA-04 | Have you implemented automated anomaly detection and failsafe mechanisms for production inputs? | Q-PO-14 |

- **A (proposed, and the checker agrees):** merge all six. Every team then sees the same questions. This departs from revision 0.5's starting point.
- **B:** keep any of them as questions of their own, shown to every team. Name which. Their help text is rewritten in sitting 2 so it does not assume a shortfall. Q-PO-EXTRA-02's question itself assumes one ("to compensate for limited team perspective diversity"), so keeping it also needs a new wording.
- The proposal's own text: Proposed: none of the six follow-up questions stays a question of its own. Shown to every team, each asks a practice that another question of its stage already asks, so each is merged into that question, which takes the union of both mappings: Q-IP-EXTRA-01 into Q-IP-04, Q-IP-EXTRA-02 into Q-IP-08, Q-PO-EXTRA-01 into Q-PO-17, Q-PO-EXTRA-02 into Q-PO-20, Q-PO-EXTRA-03 into Q-PO-07, Q-PO-EXTRA-04 into Q-PO-14. The mechanism of FR-CNT-06 is built as written (OD-22 (a)): no unlock rules, every question shown to every team, Q-IP-06 always shown. With no follow-up kept, the QC-06 help-text rule applies to no question.

**Your answer:** A, or B with the ids to keep.

### D3. OD-09: the gate and the checklists (all stages; changes only the in-processing hash)

- The gate Q-PP-GATE-SENSITIVE stays a scope answer (yes, no, not sure) that raises no finding and decides whether Q-PP-13 and Q-PP-14 apply. The five checklists Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13 and Q-PO-11 keep their questions and options, each recorded as one decision.
- Q-IP-05 ("Have you selected and analyzed appropriate fairness metrics for your use case?") is folded into the checklist Q-IP-06, because a checklist is only done when every relevant measure is ticked and every unticked one is explained, which is the choice Q-IP-05 asked for.
- **A (proposed; this is revision 0.5's own answer, and the checker agrees):** as above.
- **B:** as above, but keep Q-IP-05 as its own question, and Q-IP-06's expected practice refers to it (SRS 10.1.6).
- The proposal's own text: Proposed: keep the gate and all five checklists, each recorded as one decision (FR-CNT-03, FR-CNT-04 as built, OD-22 (a)). The gate Q-PP-GATE-SENSITIVE stays a scope answer (yes, no, not sure) that raises no finding and decides whether Q-PP-13 and Q-PP-14 apply. The checklists Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13 and Q-PO-11 keep their stems and options; Q-IP-06 absorbs Q-IP-05, because a checklist's status already records which measures fit the project.

**Your answer:** A or B.

### Checker's verdicts on the three decisions

| Item | Verdict | What the checker said, in short | Outcome |
|---|---|---|---|
| OD-08 | stands | The strongest answer for equal records: no team sees a question others do not. It departs from revision 0.5's starting point, so treat it as a choice, not a default. | no change needed |
| OD-09 | stands | It is revision 0.5's own answer. Folding Q-IP-05 into Q-IP-06 changes no checklist's question, options or meaning of done. | no change needed |
| OD-C3 | stands | Keeping the id would put two meanings under one id, which is what R-61 exists to stop. Only you can choose between the new id and setting R-61 aside. | no change needed |

## Stage 1: pre-processing

24 questions in v0.5.0, 22 proposed. Order is the order teams see them in.

### pre-processing: every v0.5.0 question

| Id | Kind | Action | Reason, in one line | New wording (reword or replace) or survivor (merge) |
|---|---|---|---|---|
| Q-PP-01 | practice | keep | The only question on whether AI is needed at all; one of two questions on PP-01, the thinnest risk area (10.1.9). |  |
| Q-PP-02 | practice | keep | Defining the problem and its success criteria is a distinct practice; PP-01 is thin, and it feeds DC-21 and MC-09. |  |
| Q-PP-03 | practice | keep | Identifying who is affected is the base the later questions on groups and consultation build on; feeds MC-10. |  |
| Q-PP-04 | practice | keep | Effects on protected or vulnerable groups. Merging Q-PP-05 into it was considered and rejected: a rights assessment covers more than group effects. |  |
| Q-PP-05 | practice | keep | A human rights impact assessment asks about the rights of everyone affected, not only groups (Q-PP-04); its expected practice will be scaled to the risk (W3). |  |
| Q-PP-06 | practice | replace | The stem describes the team's members, not a practice, so it cannot carry a status (OD-C3, 10.1.6). The practice question of worked example 2 changes what done means, so under R-61 it is a new id in the same series; the mapping stays PP-03, PP-04 (QC-02). | New id Q-PP-24: Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks? |
| Q-PP-07 | practice | keep | One of two questions on PO-05 Environmental Impact, the thinnest area (10.1.9); feeds MC-33. |  |
| Q-PP-08 | practice | keep | Survivor of Q-PP-15: sources, collection methods and the reasons for choosing the data are what a datasheet records. Feeds DC-01, DC-11 and, after the re-point, MC-12. |  |
| Q-PP-09 | practice | keep | Survivor of Q-PP-10: judging representativeness needs the subgroup distribution Q-PP-10 asked for. Feeds DC-23, MC-16 and, after the re-point, MC-15. |  |
| Q-PP-10 | practice | merge | Analysing the demographic distribution of the data is the first step of the representativeness check Q-PP-09 asks for, and Q-PP-16 also asks it as an option, so one analysis answers both. Q-PP-09 gains PP-05; MC-15 is re-pointed to Q-PP-09. | Merged into Q-PP-09 |
| Q-PP-11 | practice | keep | Proxy variables for protected attributes are a distinct check no other question asks; feeds MC-21. |  |
| Q-PP-12 | practice | keep | The only question whose stem asks about label quality; PP-07 is thin (3 questions); feeds DC-19 and DC-20. |  |
| Q-PP-GATE-SENSITIVE | gate | keep | The gate stays a scope answer that raises no finding (OD-09, FR-CNT-04); it decides whether Q-PP-13 and Q-PP-14 apply and feeds DC-16, DC-35 and MC-21. |  |
| Q-PP-13 | gate-dependent | keep | Consent, the first gate-dependent practice; feeds DC-16, and its evidence examples will include the ethics approval or waiver (CG-10). |  |
| Q-PP-14 | gate-dependent | keep | De-identification, the second gate-dependent practice; feeds DC-17 and DC-35. |  |
| Q-PP-15 | practice | merge | A datasheet is the written record of what Q-PP-08 asks (sources, collection methods, reasons for choosing the data), and the platform now builds a data card from the record, so a team would answer the same thing twice. DC-31 becomes typed only; MC-12 reads Q-PP-08's evidence. Q-PP-08's evidence examples include the datasheet or an issued data card, which is where 10.1.4 rule 4 now attaches it, so MC-12 still finds the dataset's name. | Merged into Q-PP-08 |
| Q-PP-16 | checklist | keep | Checklist kept as one decision with options in place (OD-09, FR-CNT-03); its options reach IP-07 and PO-07 and feed DC-09, DC-17 and DC-29. |  |
| Q-PP-17 | checklist | keep | Checklist kept (OD-09). Its options overlap Q-PP-09, Q-PP-18 and Q-PP-19, but survey, survivorship, measurement and exclusion bias are asked nowhere else; feeds DC-20 and DC-23. |  |
| Q-PP-18 | practice | keep | Selection bias in how the data was collected is a different check from whether the result is representative (Q-PP-09); feeds DC-07. |  |
| Q-PP-19 | practice | keep | Past discrimination carried in historical data is a distinct check; feeds DC-23. |  |
| Q-PP-20 | practice | keep | The only pre-processing question on whether the data is still current; feeds DC-13. |  |
| Q-PP-21 | practice | keep | Data governance for access, sharing and retention; feeds DC-26 and DC-29. |  |
| Q-PP-22 | practice | keep | Edge cases and rare conditions are a different check from overall representativeness; feeds DC-23 and MC-16. |  |
| Q-PP-23 | practice | keep | Review of the data by domain experts; one of three questions on PP-07, the thin labelling area; feeds DC-19. |  |

### pre-processing: document fields that change

These are the fields whose source question goes. Once you approve, C-MAP applies exactly this list to the field maps (its task CW-11b). "Typed only" means the team types the value into the document; it is not taken from the sealed record.

| Document | Field id | Label | Old source | New source | The field then reads |
|---|---|---|---|---|---|
| Data card | DC-31 | Datasheet held by the team | Q-PP-15 | typed only | typed by the team |
| Model card | MC-12 | Dataset name | Q-PP-15 | Q-PP-08 | typed by the team; Q-PP-08 (evidence) |
| Model card | MC-15 | Geographic scope and demographic composition | Q-PP-10 | Q-PP-09 | Q-PP-09 (status, reason); project: country |

Field ids and labels are read from C-MAP's field maps at commit `0c6c6bfc`; each field exists and reads the old source today.

### pre-processing: coverage check

Result: **pass** (no `FAIL` line; exit code 0). The full output is in Appendix A. The lines for this stage:

```
LIST questions=67 pre-processing=22 in-processing=22 post-processing=23
LIST thinned area=PP-02 stage=pre-processing before=7 after=6
LIST thinned area=PO-07 stage=pre-processing before=3 after=2
LIST srs-named id=Q-PP-10 action=merge lines=2078
LIST srs-named id=Q-PP-15 action=merge lines=2078
```

- **Risk areas with fewer questions in this stage:** 2. Each area still has at least one question; none is lost.
- **Spec ids this stage removes that the spec still names** (sections 3, 4, 7, 12): Q-PP-10, Q-PP-15. Information only: those spec lines are updated after your approval; the other units' tests run on fixture ids, not on these.

### pre-processing: the checker's verdicts

| Item | Verdict | What the checker said, in short | Outcome |
|---|---|---|---|
| Q-PP-06 | change | The replacement is right. One defect: the new question had no 'principle' label. Applied: Q-PP-24 takes Q-PP-06's label, Multi-stakeholder Collaboration, and the coverage check now fails a new question without one. | applied in the revision; not disputed |
| Q-PP-10 | stands | Judging whether the data represents the population needs the breakdown by group that Q-PP-10 asked for, so nothing is lost. Sitting 2 must make Q-PP-09's expected practice name that comparison. | no change needed |
| Q-PP-15 | change | The merge is right only if the datasheet is attached as Q-PP-08's evidence. Applied: Q-PP-15's reason now says Q-PP-08's evidence examples include the datasheet or an issued data card. | applied in the revision; not disputed |
| repoint:data_card:DC-31 | stands | Typed only is honest. Whether the data card needs this field at all is your call (question F1). | no change needed |
| repoint:model_card:MC-12 | stands | Holds, given the sentence added to Q-PP-15's reason. | no change needed |
| repoint:model_card:MC-15 | stands | Holds. MC-16 then prints 'See MC-15', which reads well if Q-PP-09's reason prompt asks for the make-up of the data first. | no change needed |

### pre-processing: questions for you

- D1 (OD-C3, Q-PP-06 or Q-PP-24).
- D3 (the gate and the checklists Q-PP-16 and Q-PP-17; no change to this stage's hash).
- F1: DC-31 "Datasheet held by the team" becomes typed only. The checker left it to you whether a data card, which is itself built on the datasheet practice (C-19), still needs this field. **Keep it as a typed field (proposed), or ask for it to be removed from the data card?** Removing it is a field-map change C-MAP makes; it does not change this stage's hash.

### pre-processing: what you sign

Batch `question-set:pre-processing`: the ids and wordings below, in this order. Batch hash: **`3996fee4a4e4b120f417151cdbeca27f08c954c19632a1e92d14156b5d1f1a20`**

1. Q-PP-01: Have you evaluated whether AI/ML is the most appropriate approach, compared to simpler alternatives (e.g., statistical models, rule-based systems, manual processes)?
2. Q-PP-02: Have you clearly defined the problem your AI system aims to solve, including specific objectives and success criteria?
3. Q-PP-03: Have you identified all stakeholders who are directly or indirectly affected by the AI system?
4. Q-PP-04: Have you assessed how the AI system might affect protected or vulnerable groups (e.g., by gender, age, ethnicity, disability, socioeconomic status)?
5. Q-PP-05: Have you conducted a human rights impact assessment for the AI system?
6. Q-PP-24: Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks?
7. Q-PP-07: Have you assessed the environmental sustainability impact (e.g., energy consumption, carbon footprint) of the proposed AI solution?
8. Q-PP-08: Have you documented the data sources, collection methods, and rationale for data selection?
9. Q-PP-09: Have you assessed whether your training data is representative of the target population?
10. Q-PP-11: Have you identified and addressed potential proxy variables for protected attributes?
11. Q-PP-12: Have you ensured the quality and consistency of data labels/annotations?
12. Q-PP-GATE-SENSITIVE: Does your dataset contain sensitive or personally identifiable information (PII)?
13. Q-PP-13: Have you obtained proper informed consent for data collection and use?
14. Q-PP-14: Have you applied appropriate anonymization or pseudonymization techniques to protect personal data?
15. Q-PP-16: Which of the following data quality assessments have you performed?
16. Q-PP-17: Which of the following bias types have you assessed for in your data?
17. Q-PP-18: Have you assessed whether your data collection methods could introduce selection bias?
18. Q-PP-19: Have you evaluated whether historical patterns in the data reflect past discrimination or systemic inequities?
19. Q-PP-20: Have you assessed the temporal relevance of your training data?
20. Q-PP-21: Have you established data governance policies covering access, sharing, and retention?
21. Q-PP-22: Have you evaluated whether your data adequately represents edge cases and rare conditions?
22. Q-PP-23: Have you engaged domain experts in reviewing data quality and relevance?

## Stage 2: in-processing

26 questions in v0.5.0, 22 proposed. Order is the order teams see them in.

### in-processing: every v0.5.0 question

| Id | Kind | Action | Reason, in one line | New wording (reword or replace) or survivor (merge) |
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

### in-processing: document fields that change

These are the fields whose source question goes. Once you approve, C-MAP applies exactly this list to the field maps (its task CW-11b). "Typed only" means the team types the value into the document; it is not taken from the sealed record.

| Document | Field id | Label | Old source | New source | The field then reads |
|---|---|---|---|---|---|
| Model card | MC-19 | Disaggregated performance (subgroup x metric table) | Q-IP-EXTRA-01 | typed only | typed by the team; Q-IP-04 (status, evidence) |
| Model card | MC-20 | Fairness metrics with the team's own threshold | Q-IP-05 | Q-IP-06 | typed by the team; Q-IP-06 (reason); Q-IP-06 (options) |

Field ids and labels are read from C-MAP's field maps at commit `0c6c6bfc`; each field exists and reads the old source today.

### in-processing: coverage check

Result: **pass** (no `FAIL` line; exit code 0). The full output is in Appendix A. The lines for this stage:

```
LIST questions=67 pre-processing=22 in-processing=22 post-processing=23
LIST thinned area=IP-01 stage=in-processing before=8 after=6
LIST thinned area=IP-03 stage=in-processing before=7 after=6
LIST srs-named id=Q-IP-EXTRA-01 action=merge lines=717
LIST srs-named id=Q-IP-EXTRA-02 action=merge lines=717
```

- **Risk areas with fewer questions in this stage:** 2. Each area still has at least one question; none is lost.
- **Spec ids this stage removes that the spec still names** (sections 3, 4, 7, 12): Q-IP-EXTRA-01, Q-IP-EXTRA-02. Information only: those spec lines are updated after your approval; the other units' tests run on fixture ids, not on these.

### in-processing: the checker's verdicts

| Item | Verdict | What the checker said, in short | Outcome |
|---|---|---|---|
| Q-IP-05 | stands | A checklist is done only when every relevant measure is ticked and the rest explained, which is the choice Q-IP-05 asked for. Coverage does not change. | no change needed |
| Q-IP-23 | stands | The spec names this pair as near-duplicates and both map the same risk area. Sitting 2 must make Q-IP-09 say the team set what acceptable performance means. | no change needed |
| Q-IP-EXTRA-01 | stands | The same per-group evaluation as Q-IP-04 (worked example 5). The merge also drops a fixed 5-point rule and help text that assumed the team had fallen short. | no change needed |
| Q-IP-EXTRA-02 | stands | Testing with faulty inputs is the robustness test Q-IP-08 already asks for. Side effect: Q-IP-08 now also suggests C-17 Model Card and C-19 Datasheet. | no change needed |
| repoint:model_card:MC-19 | stands | Right as data. Applied to the table: it now shows the sources the field keeps (typed plus Q-IP-04), not only 'typed only'. | no change needed |
| repoint:model_card:MC-20 | stands | Holds. C-MAP should join the two Q-IP-06 sources into one when it applies the list, so the model card does not print the extract twice. | no change needed |

### in-processing: questions for you

- D2 (Q-IP-EXTRA-01 and Q-IP-EXTRA-02).
- D3 (Q-IP-05 folded into Q-IP-06).
- N1: Q-IP-20 reads "Have you documented the model's known limitations, failure modes, and conditions under which it should not be used?" The platform's banned-claims check (lib/claims/pattern.ts) was widened after the checker ran and now flags "failure". **Keep the wording, allowed by its id because it asks about the team's own practice (spec AL-7), or reword it?** A reword changes this stage's hash, and a wording that changes what done means needs a new id.

### in-processing: what you sign

Batch `question-set:in-processing`: the ids and wordings below, in this order. Batch hash: **`fa78660124564f2cd8bc7bfb38f89b1ea066da3aaa4dd6016fd478cc244a46fa`**

1. Q-IP-01: Have you justified the choice of model architecture relative to the problem complexity and data availability?
2. Q-IP-02: Have you ensured that training, validation, and test datasets are representative of the same underlying population?
3. Q-IP-03: Have you evaluated model performance using a confusion matrix and derived metrics (precision, recall, F1, specificity)?
4. Q-IP-04: Have you calculated performance metrics separately for each relevant subgroup (e.g., by age, gender, ethnicity)?
5. Q-IP-06: Which fairness metrics have you computed?
6. Q-IP-07: Have you applied explainability methods (e.g., SHAP, LIME, feature importance) to understand model decisions?
7. Q-IP-08: Have you tested the model's robustness to distribution shifts, noise, and edge cases?
8. Q-IP-16: Have you compared your model's performance against a simple baseline (e.g., majority class, logistic regression)?
9. Q-IP-17: Have you assessed whether the model relies on spurious correlations rather than meaningful features?
10. Q-IP-18: Have you evaluated model uncertainty and calibration quality?
11. Q-IP-09: Have you applied the parsimony principle, seeking the simplest model that achieves acceptable performance?
12. Q-IP-10: Have you documented all hyperparameters, random seeds, and training configurations for reproducibility?
13. Q-IP-11: Have you validated data integrity through your processing pipeline (ETL checks, validation rules)?
14. Q-IP-12: Have you created or updated a model card for this model?
15. Q-IP-13: Which additional evaluation methods have you applied?
16. Q-IP-14: Have you considered whether aggregating data across populations masks important subgroup differences?
17. Q-IP-15: Have you identified and mitigated any bias introduced during hyperparameter tuning?
18. Q-IP-19: Have you assessed whether the model's errors have differential impact across demographic groups?
19. Q-IP-20: Have you documented the model's known limitations, failure modes, and conditions under which it should not be used?
20. Q-IP-21: Have you used version control for your model code, data processing pipelines, and trained model artifacts?
21. Q-IP-22: Have you assessed the model for potential adversarial vulnerabilities or manipulation?
22. Q-IP-24: Have you tested the model's performance on data from different time periods to assess temporal stability?

## Stage 3: post-processing

28 questions in v0.5.0, 23 proposed. Order is the order teams see them in.

### post-processing: every v0.5.0 question

| Id | Kind | Action | Reason, in one line | New wording (reword or replace) or survivor (merge) |
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

### post-processing: document fields that change

No document field reads a question this stage merges or replaces, so no field changes.

### post-processing: coverage check

Result: **pass** (no `FAIL` line; exit code 0). The full output is in Appendix A. The lines for this stage:

```
LIST questions=67 pre-processing=22 in-processing=22 post-processing=23
LIST thinned area=PO-01 stage=post-processing before=9 after=8
LIST thinned area=PO-04 stage=post-processing before=6 after=5
LIST thinned area=PO-06 stage=post-processing before=6 after=5
LIST thinned area=PO-07 stage=post-processing before=4 after=3
LIST srs-named id=Q-PO-EXTRA-01 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-02 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-03 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-04 action=merge lines=717
```

- **Risk areas with fewer questions in this stage:** 4. Each area still has at least one question; none is lost.
- **Spec ids this stage removes that the spec still names** (sections 3, 4, 7, 12): Q-PO-EXTRA-01, Q-PO-EXTRA-02, Q-PO-EXTRA-03, Q-PO-EXTRA-04. Information only: those spec lines are updated after your approval; the other units' tests run on fixture ids, not on these.

### post-processing: the checker's verdicts

| Item | Verdict | What the checker said, in short | Outcome |
|---|---|---|---|
| Q-PO-19 | stands | The spec names this pair as near-duplicates. Sitting 2 must make Q-PO-10's expected practice name power, connectivity and devices. | no change needed |
| Q-PO-EXTRA-01 | stands | Monitoring fairness in production is monitoring results per group, which Q-PO-17 asks. | no change needed |
| Q-PO-EXTRA-02 | stands | Its stem assumes the team lacks diversity and rests on Q-PP-06's rating, which goes. Its practice is still asked by Q-PO-20 and by options of Q-PO-11. One clause of its reason assumes you choose A for D1; the merge stands either way. | no change needed |
| Q-PO-EXTRA-03 | change | The merge most likely to lose a practice: showing users the main reasons for an output about a person. Applied: the reason now commits Q-PO-07's expected practice to keep it, in proportion to the risk; sitting 2 checks the text. | applied in the revision; not disputed |
| Q-PO-EXTRA-04 | stands | Failing safely needs unusual inputs to be detected first, which Q-PO-14 covers. Q-PO-14 now also suggests C-22, C-23 and C-26. | no change needed |

### post-processing: questions for you

- D2 (Q-PO-EXTRA-01 to Q-PO-EXTRA-04).
- D3 (the checklist Q-PO-11; no change to this stage's hash).
- N2: Q-PO-14 reads "Is the system designed to gracefully degrade or fail safely when it encounters out-of-distribution inputs?" The same check flags "fail". **Keep the wording, allowed by its id (AL-7), or reword it?** Q-PO-14 also absorbs Q-PO-EXTRA-04 under D2. A reword changes this stage's hash.
- For information, no answer needed: Q-PO-22 ("Have you ensured compliance with applicable data protection regulations and ethical guidelines?") is also flagged, for "compliance"; the spec already settles it: keep the wording, allowed by its id (SRS 10.1.6, AL-7).

### post-processing: what you sign

Batch `question-set:post-processing`: the ids and wordings below, in this order. Batch hash: **`11098ba94ebfe3431e1f5ae83a0b44a8e7b721fd305af6f0ef5efa9089540802`**

1. Q-PO-01: Have you established continuous monitoring for model performance degradation and data drift?
2. Q-PO-02: Have you defined triggers and procedures for model retraining?
3. Q-PO-03: Is there a human-in-the-loop mechanism for reviewing and overriding AI decisions?
4. Q-PO-04: Have you defined clear roles and responsibilities for AI system outcomes (accountability matrix)?
5. Q-PO-05: Have you created an incident response plan for when the AI system produces harmful outputs?
6. Q-PO-06: Have you provided training or educational resources for end-users of the AI system?
7. Q-PO-07: Can end-users understand the AI system's outputs, confidence levels, and limitations?
8. Q-PO-16: Have you implemented A/B testing or staged rollout procedures for model deployment?
9. Q-PO-17: Have you established monitoring for fairness metrics in production, not just accuracy?
10. Q-PO-18: Have you defined performance thresholds below which the system should be automatically disabled or flagged?
11. Q-PO-08: Have you established feedback channels for affected communities and end-users?
12. Q-PO-09: Is there a mechanism for individuals affected by AI decisions to contest or appeal those decisions?
13. Q-PO-10: Have you created complete documentation for the deployed system (codebook, deployment specs)?
14. Q-PO-11: Which of the following governance measures are in place?
15. Q-PO-12: Have you assessed the AI system's performance across the deployment context's diversity (geographic, linguistic, cultural)?
16. Q-PO-13: Have you planned for the eventual decommissioning or replacement of the AI system?
17. Q-PO-14: Is the system designed to gracefully degrade or fail safely when it encounters out-of-distribution inputs?
18. Q-PO-15: Have you communicated the AI system's limitations and intended use to all stakeholders?
19. Q-PO-20: Have you involved representatives of affected communities in the design and evaluation of the AI system?
20. Q-PO-21: Have you assessed the AI system's impact on existing workflows and professional practices?
21. Q-PO-22: Have you ensured compliance with applicable data protection regulations and ethical guidelines?
22. Q-PO-23: Have you established regular review cycles to reassess the AI system's appropriateness and performance?
23. Q-PO-24: Have you considered the AI system's impact on equity of access to services?

## The checker's verdicts on the method

These are about how the check and the tables work, not about a single question. All are settled.

| Item | Verdict | What the checker said, in short | Outcome |
|---|---|---|---|
| judgment:replacement-order | stands | A replacement sits where the old question sat, so the order you sign is the order you see. | no change needed |
| judgment:cross-stage-merge | change | A merge across stages must fail, because no single stage sitting would see it whole. Applied to the coverage check; no merge in this proposal crosses stages. | applied in the revision; not disputed |
| judgment:thinned-per-stage | change | Count thinned risk areas per stage, so a loss in one stage is not hidden in another. Applied: the lists in this pack are per stage. | applied in the revision; not disputed |
| judgment:option-map-on-non-checklist | stands | Keep it a failure. It does not touch this proposal. | no change needed |
| render:stage-tables | change | Show each question's kind, each field's sources after the change, and the three decisions in every stage table. Applied. | applied in the revision; not disputed |

## For information (no answer needed)

- Q-PP-24 is a new id. The test fixtures do not hold it; the controller already knows, and no test outside this unit reads the real ids.
- A question that absorbs another takes both risk-area mappings, so it suggests more controls on the screen "Ways teams address this". For example Q-IP-08 now also suggests C-17 Model Card and C-19 Datasheet, and Q-PO-14 suggests C-22, C-23 and C-26. That follows from the merge rule and cannot be trimmed without a mapping change.
- Q-IP-06 becomes the only checklist that also maps a risk area directly (IP-01). The question-control pairs do not change, because every option of Q-IP-06 already maps IP-01.
- Linking Q-PP-24 to C-20 Multi-stakeholder Consultation through risk area PP-01 (CG-19) would be a mapping change, which this version does not allow. Its "why this is asked" text in sitting 2 names C-20 instead.
- With all six follow-ups merged, the help-text rule for follow-ups (QC-06) has nothing to check. The content tests will state that 5.0.0 holds no follow-up id, so that pass is a stated fact.

## How the batch hash is computed

For each stage, the payload is `{ "batch": "question-set:<stage>", "questions": [ { "id", "text" }, ... ] }`, holding the stage's approved ids and wordings in the order teams see them, with a replacement in the place of the question it replaces. The hash is the lowercase hex SHA-256 of the UTF-8 bytes of that payload's canonical JSON (`canonicalJson`, `lib/integrity/canonical.mjs`). This is `signOffHash(signOffPayload(...))` of `lib/content/signoffs.ts` (contract gap G075). The three hashes were computed twice on the merged tree, with the table renderer and with `signOffHash` itself, and agree. The order and wordings used are those of `data/content/5.0.0/questionBank.json` today, which equal v0.5.0 (`d13be0c`) question for question; the revision is applied to that file with each replacement in its predecessor's place, so the sign-off record computed from the revised file carries the same hash, and the sign-off command refuses to write one that differs.

## Appendix A: the coverage check's full output

Command, run on the merged tree: `npx tsx scripts/content/question-set-coverage.ts --bank <d13be0c questionBank.json> --areas <d13be0c assessmentAreas.json> --proposal docs/content/question-set-5.0.0/proposal.json --fieldmaps <C-MAP data/fieldmaps at 0c6c6bfc> --srs records/plans/2026-10-28-v1-srs.md`. Exit code 0; the output equals `coverage-report.txt`.

```
LIST inputs bank-sha256=18e39eb8f4e0cbfbffb79bd4da15fb38ccc0ac704b70fa13f3bb14813e66b009 areas-sha256=a5aef6d06b7ae768046675d6ca25cf23fae0a44d3d251aecc4259ccda01fbd02
LIST base questions=78 areas=21 controls=28
LIST proposal status=revised actions=78 keep=66 reword=0 merge=11 cut=0 replace=1
LIST fieldmaps documents=data_card,mitigation_plan,model_card fields=78 question-sources=50 repoints=5
LIST questions=67 pre-processing=22 in-processing=22 post-processing=23
LIST pairs=283
LIST pairs-base=315
LIST unmapped question=Q-PP-GATE-SENSITIVE
LIST thinned area=PP-02 stage=pre-processing before=7 after=6
LIST thinned area=PO-07 stage=pre-processing before=3 after=2
LIST thinned area=IP-01 stage=in-processing before=8 after=6
LIST thinned area=IP-03 stage=in-processing before=7 after=6
LIST thinned area=PO-01 stage=post-processing before=9 after=8
LIST thinned area=PO-04 stage=post-processing before=6 after=5
LIST thinned area=PO-06 stage=post-processing before=6 after=5
LIST thinned area=PO-07 stage=post-processing before=4 after=3
LIST srs-scanned sections=3,4,7,12 ids=29
LIST srs-named id=Q-IP-EXTRA-01 action=merge lines=717
LIST srs-named id=Q-IP-EXTRA-02 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-01 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-02 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-03 action=merge lines=717
LIST srs-named id=Q-PO-EXTRA-04 action=merge lines=717
LIST srs-named id=Q-PP-10 action=merge lines=2078
LIST srs-named id=Q-PP-15 action=merge lines=2078
```

## Appendix B: the checker's reasons, in full

From `adversarial-check.json` (Task 4, an Opus agent other than the proposer), verbatim. Where a verdict is "change", the proposer applied it in the revision.

**Q-PP-06** (change). The replace stands on all five lines. The new stem is worked example 2's proposed stem word for word (SRS line 4040). It asks for a practice a colleague can check, not a description of the team's members, and it records no personal detail. The meaning changes, so a new id is right under R-61 (line 3896, which gives Q-PP-24 as its own example). QC-02 allows only the mapping PP-03, PP-04, because a replacement's pairs must equal the replaced question's pairs (line 4228). Mapping it to PP-01 for C-20 (CG-19) is a later mapping change for the owner. One defect: the new question has no principle, and the contract requires one (00-contract.md:461, NewQuestion principle: string; ContentQuestion at line 386). As written the proposal does not fit QuestionSetProposal, which is CNT's stop-and-report item 8 (units/CNT.md:760). Task 6's apply-revision.ts cannot build a valid question from it. Exact change: in newQuestions, on Q-PP-24, add "principle": "Multi-stakeholder Collaboration". That is Q-PP-06's principle at d13be0c, a label only (OD-13). Also make scripts/content/coverage.ts step 2 fail a new question whose principle is missing or blank, with a test, because the check passed this defect. For the controller: the contract's fixture rule (00-contract.md:1107) calls 'Q-PP-01 to Q-PP-24' v0.5.0 ids. But v0.5.0 ends at Q-PP-23, and Q-PP-24 is now this new question, so that line should read Q-PP-23.

**Q-PP-10** (stands). Judging whether the data represents the target population (Q-PP-09) needs the breakdown by group that Q-PP-10 asks for. So the absorbed practice sits inside the survivor's stem, and W2 does not stop Q-PP-09's expected practice from asking for it. The same breakdown is also the Q-PP-16 option 'Distribution analysis across subgroups', so it is still recorded. The union is right: Q-PP-09 maps PP-02, PP-04, PP-05 (checked against d13be0c). PP-05, a thin area (line 4210), keeps its 4 questions, and no control loses its last question. For Task 7, Q-PP-09's expected practice must name the comparison by group (for example sex, age band, district). Its reason prompt now names MC-15 as well as DC-23 and MC-16 (W10). The C-05 notebook's 'Supports' line (line 4694) names Q-PP-10; C-NB generates links from the approved set (NB-AC-06).

**Q-PP-15** (change). The merge stands; its reason needs one more sentence. A datasheet covers more than Q-PP-08's stem: composition, preprocessing, intended uses, distribution and maintenance. Composition is asked by Q-PP-09 and Q-PP-16, and preprocessing by Q-PP-16 (DC-17). Intended uses come from Q-PP-02 (DC-21) and retention from Q-PP-21 (DC-29). Distribution and maintenance are typed fields, DC-24 to DC-28. The data card is itself built on the C-19 datasheet (SRS 10.3.2), so asking whether the team holds a datasheet duplicates the document the record produces. C-19 is still reached through PO-07 from Q-PP-08 and Q-PP-16. What would be lost is where the datasheet file sits. MC-12 is re-pointed to Q-PP-08's evidence on the assumption that the datasheet is attached there. SRS 10.1.4 rule 4 (line 3977) and the what-if row at line 4485 still name Q-PP-15 for an issued data card. Nothing in the approved set would carry this to the drafters. Exact change. Append this sentence to the action's reason: " Q-PP-08's evidence examples include the datasheet or an issued data card, which is where 10.1.4 rule 4 now attaches it, so MC-12 still finds the dataset's name."

**Q-IP-05** (stands). Q-IP-05 asks the team to choose the fairness measures that fit its use. The checklist rule already demands that choice. Done means every option relevant to the project is ticked and every unticked one is explained as not relevant (10.1.3, line 3947). The union is right: Q-IP-05 maps IP-01 only, and every option of Q-IP-06 already maps IP-01, so the pairs do not change. IP-01 in gaps is the literal union of line 3908, and SUG's area rule reads gaps on a checklist without trouble (units/SUG.md:139). Records stay equal: every team makes one decision here instead of two, and Q-IP-06 is shown to all (FR-CNT-06). Three things to carry into Task 7. The 10.1.6 rule that Q-IP-06's expected practice refers to the metrics chosen under Q-IP-05 (line 4019) loses its target. The expected practice must say instead that the team chose the measures that fit its use, and why. The team's own threshold (W4) moves to Q-IP-06's reason prompt, which now names MC-20. A team whose fitting measure is not among the nine options can still be done, with the measure named in the reason.

**Q-IP-23** (stands). SRS 10.1.9 names this pair as near-duplicates (line 4215). Seeking the simplest model that performs acceptably is how the trade-off between performance and interpretability is settled, provided the team sets what acceptable means (W4). Both map IP-03 only, so no area or control moves, and no document field reads Q-IP-23. For Task 7, Q-IP-09's expected practice should say the team set what acceptable performance means for this use. It should also say the team weighed how far the people affected need to follow each decision, and wrote the choice down. The C-18 notebook's 'Supports' line (line 4745) names Q-IP-23; C-NB generates links from the approved set (NB-AC-06).

**Q-IP-EXTRA-01** (stands). It is the same per-group evaluation as Q-IP-04; worked example 5 already says one analysis answers both (line 4075). Q-IP-04 gains IP-04, the literal union. The merge also drops the follow-up's fixed 5-point rule, which W4 forbids (line 3931), and its help text that assumed an earlier shortfall. No team now sees a question that presumes it skipped an audit. MC-19 keeps Q-IP-04 and its typed table (see repoint:model_card:MC-19). The C-13, C-14 and C-15 notebook lines (lines 4663 to 4665, 4720) name it; C-NB regenerates them.

**Q-IP-EXTRA-02** (stands). Adding missing values, label errors or shifted data to the validation set and measuring the change is a test of robustness to noise and shift. Q-IP-08's stem asks for exactly that. Q-IP-13 also offers 'Sensitivity/perturbation analysis' as an option, so the method is still recorded. The union is right: Q-IP-08 maps IP-05, IP-03, IP-06. The owner should know a side effect: through IP-03 and IP-06, Q-IP-08 now also suggests C-17 Model Card and C-19 Datasheet. That follows from the union rule (line 3908) and cannot be trimmed without a mapping change. CG-03's demand that the expected practice name robustness methods now falls on Q-IP-08 and Q-IP-22.

**Q-PO-19** (stands). SRS 10.1.9 names the pair (line 4215). The requirements and dependencies of the deployed system are part of the deployment specifications Q-PO-10 asks for. Both map PO-07 only, and no document field reads Q-PO-19. The risk is that the setting teams face (W7: power, connectivity, devices) drops out of the text. The proposer's keep reason for Q-PO-10 promises its expected practice will name them; Task 9 should hold the drafter to that.

**Q-PO-EXTRA-01** (stands). Monitoring fairness in production is monitoring results per group, so the follow-up asks what Q-PO-17 asks (pair named at line 4215). Q-PO-17 gains PO-06, the literal union. The follow-up's help text assumed a shortfall in pre-processing (QC-06), which would be false for most teams once it is shown to all. No document field reads it.

**Q-PO-EXTRA-02** (stands). The stem presumes a shortfall ('to compensate for limited team perspective diversity') and rests on Q-PP-06's diversity rating, which goes. Shown to every team, it would be false for most. Its practice is still asked. Review by the people affected is Q-PO-20. An ethics review board, a community advisory board and regular third-party audits are options of Q-PO-11 (checked at d13be0c). The union is right: Q-PO-20 maps PO-06, PO-02. One clause of the reason depends on OD-C3: 'missing perspectives are brought in by Q-PP-24' holds only if the owner approves the replace. The merge stands either way.

**Q-PO-EXTRA-03** (change). This merge is the one most likely to lose a practice. Showing users why an output was given is one way of making outputs understandable, so it can sit inside Q-PO-07. But Q-PO-07's stem lists outputs, confidence levels and limitations, not reasons. Read strictly, W2 would keep its expected practice from asking for reasons. Then no question asks for them: Q-IP-07 is the team's own analysis, and Q-PO-03 and Q-PO-09 do not ask. The reason as written also says this follow-up 'would exceed W3', which an owner can read as dropping the practice. The stem also reads as a state of the users, so Task 7 must write the expected practice as what the team did (W1). Merging into Q-IP-07 instead would cross stages (see judgment:cross-stage-merge). Exact change. Append this sentence to the action's reason: " Q-PO-07's expected practice keeps the practice: in proportion to the risk, where an output is about a person, the user can see the main reasons for it." Task 9 should check Q-PO-07's text against that sentence.

**Q-PO-EXTRA-04** (stands). Failing safely on unfamiliar inputs needs those inputs to be detected first, so detection and a fallback sit inside Q-PO-14's stem. 'Automated' is not carried over, which fits W3 for a small team. The follow-up's circuit breakers for sustained degradation are Q-PO-18's practice (thresholds to disable or flag), which stays. Q-PO-14 gains PO-01 and PO-03, so it now also suggests C-22, C-23 and C-26; that follows from the union rule. No document field reads it.

**OD-08** (stands). Merging all six follow-ups is inside the owner's trim answer and inside OD-22 (a). The revision decides which follow-ups remain (line 3890). FR-CNT-06's mechanism is still built: no unlock rules, and Q-IP-06 shown to all. On the fifth line of attack it is the strongest answer. No team sees a question others do not, and none sees text that assumes it fell short. It departs from revision 0.5's starting point ('always show the follow-ups'), so the owner should see it as a departure, not a default. Two consequences for others. QC-06 (line 4232) and CNT's QC-06 rule (units/CNT.md:521) will pass with nothing to check. Task 8's QC-06 test should assert that 5.0.0 holds no id containing -EXTRA-, so the pass is a fact, not an accident. Also, FR-CNT-06 (line 717), the follow-up row of 10.1.3 (line 3946), the follow-up rule of 10.1.6 and CG-12 still name six questions that will not exist. The coverage report lists line 717 only, because it scans sections 3, 4, 7 and 12.

**OD-09** (stands). It is revision 0.5's answer (line 3890): each checklist is one decision with its options in place (FR-CNT-03), and the gate takes a scope answer and raises no finding (FR-CNT-04). Every team gets the same kind of record. The gate still decides Q-PP-13 and Q-PP-14, and the coverage check fails if a kept question depends on a removed gate. Folding Q-IP-05 into Q-IP-06 changes no checklist's stem, options or done rule.

**OD-C3** (stands). The old stem describes the team's members and cannot carry a status (10.1.6, line 4020). Revision 0.5's reword kept the id. But R-61, as revised after the what-if analysis (line 3799), gives a meaning change a new id. This is one: the old stem asked how diverse the team is. The new one asks whether the team found and filled the perspectives the problem needs. Keeping the id would put two meanings under one id, the failure R-61 exists to stop. Before the first real seal the new id costs only regeneration (OD-17). The decision text is right to put the R-61 waiver to the owner as an explicit choice. Only the owner can choose between the replace and the waiver.

**repoint:data_card:DC-31** (stands). DC-31 reads only Q-PP-15, so after the merge it needs a new source. Q-PP-08's record would print a stem about sources and methods under 'Datasheet held by the team', the weak source 10.3 drops (line 4285). Typed only is honest: it prints 'Typed for this document; not part of the sealed record'. With C-MAP's rule (units/C-MAP.md:339) the field becomes one typed source. Whether a data card built on the C-19 datasheet needs this field at all is the owner's call under 10.3.

**repoint:model_card:MC-12** (stands). MC-12 'Dataset name' reads typed text plus Q-PP-15's evidence. After the merge the datasheet is attached to Q-PP-08, so Q-PP-08's evidence is where the same file sits. With C-MAP's rule the field becomes typed plus Q-PP-08 evidence. Q-PP-08 is a pre-processing question like Q-PP-15, so the field reads the same stage's seal (D3, line 4304). It holds only with the sentence the Q-PP-15 entry adds.

**repoint:model_card:MC-15** (stands). Q-PP-09 now carries the group breakdown Q-PP-10 asked for, and is pre-processing like it. With C-MAP's rule MC-15 reads Q-PP-09 status and reason, and the project's country. MC-16 also reads Q-PP-09, so rule D4 (line 4305) prints the full extract under MC-15 and 'See MC-15' under MC-16. That reads well enough, provided Q-PP-09's reason prompt asks first for the make-up of the data by group and place. Then it asks for the groups the data under-represents (W10).

**repoint:model_card:MC-19** (stands). Right as data. MC-19 already reads typed text and Q-IP-04. With C-MAP's rule (units/C-MAP.md:339), 'typed_only' removes the Q-IP-EXTRA-01 source and adds nothing, because a typed source is already there. The field ends as typed plus Q-IP-04 status and evidence. Pointing it to Q-IP-04 instead would add a second Q-IP-04 source. Checked against C-MAP's maps at b50cd5f. The fault is only in how the table shows it: 'typed only' tells the owner the field lost its record source, which is false. See render:stage-tables.

**repoint:model_card:MC-20** (stands). Q-IP-06 absorbs Q-IP-05, so its reason is the right source for the team's choice and threshold. With C-MAP's rule the field becomes typed, Q-IP-06 reason and Q-IP-06 options: two record sources for one question (C-MAP's maps at b50cd5f). Unless CW-11b joins them into one source with parts reason and options, the model card may print the Q-IP-06 extract twice in one field. FieldRepoint cannot say that, so it is CW-11b's to do (C-TXT-1.yaml needs_judgment raised it).

**judgment:replacement-order** (stands). A replacement takes its predecessor's place in content order, as render-tables.ts does now. The owner's table already shows Q-PP-24's stem in Q-PP-06's row, so the order signed is the order seen. Content order is not id order anyway: Q-IP-16 to Q-IP-18 sit before Q-IP-09 at d13be0c. The end of the module would put the perspectives question after the environmental question Q-PP-07. That parts it from the stakeholder questions Q-PP-03 to Q-PP-05 it builds on. A change now would also change the pre-processing hash. One condition. The hash the owner signs must equal CNT's signOffPayload over the bank (units/CNT.md:521). So Task 6's apply-revision.ts and sign-off.ts --from-proposal must import the ordering from scripts/content (reviseQuestions or questionSetPayload), not re-implement it. Task 6's R-61 test should also assert that 5.0.0's questionsInStage order equals the proposal's order.

**judgment:cross-stage-merge** (change). A merge across stages should fail. The owner approves stage by stage. Such a merge would remove a question from one stage's table and grow a question in another, and neither sitting would see the whole change. Each stage is sealed on its own. A document field takes a source from its own stage's latest seal (D3, line 4304), so moving a practice changes which seal answers it. When a practice happens is part of the practice. A check on the data before training is not a check on the model after it; that is the first line of attack (line 3892). R-61 already keeps a replacement in its stage's series. The check fails a cross-stage replacement but not a cross-stage merge. No committed merge crosses stages, so the rule costs nothing now. Exact change. In scripts/content/coverage.ts step 3 (the merge loop), after the existing checks, add a failure when the two base questions' stages differ. Its text: 'merge of <id> (<stage>) into <into> (<stage>) crosses stages'. Add a test to __tests__/content/question-set-coverage.test.ts. If the owner ever wants such a merge, it goes to disputed for the owner.

**judgment:thinned-per-stage** (change). Count thinned areas per area and per stage of the questions counted, not once per area. SRS 10.1.0 step 2 asks for every risk area whose question count falls in a stage (line 3891). The owner reads the list stage by stage. Eleven questions reach risk areas of another stage (CG-13, line 4271), so one total hides where a loss falls. On this proposal the current list says 'PO-07 stage=post-processing before=9 after=7'. In fact PO-07 falls from 3 to 2 among pre-processing questions (Q-PP-15 merged). It falls from 4 to 3 among post-processing ones (Q-PO-19 merged). The pre-processing sitting would not see its drop. Recomputed with python3 from d13be0c and the proposal, the per-stage list is as follows. In-processing: IP-01 8 to 6, IP-03 7 to 6. Post-processing: PO-01 9 to 8, PO-04 6 to 5, PO-06 6 to 5, PO-07 4 to 3. Pre-processing: PO-07 3 to 2, PP-02 7 to 6. Exact change. In scripts/content/coverage.ts step 6, loop over STAGES and areas. Count only the base and revised questions of that stage. Push { area, stage: <that stage>, before, after } when after is less than before. The return type and the LIST line format stay the same. Regenerate coverage-report.txt in Task 5.

**judgment:option-map-on-non-checklist** (stands). Keep it a FAIL. An optionGapMap on a question that is not a checklist names options the form never offers, so no answer can tick or untick them. FR-SUG-02's split by ticked option has nothing to act on. The engine at d13be0c reads the map only on checklists (components/report/useFindingsData.ts:269). Counting those areas toward QC-02 would claim reach that the record cannot show. The fix, when it arises, keeps the union and is cheap: move the areas into gaps. The committed proposal is not affected; its only survivor with a map, Q-IP-06, is a checklist.

**render:stage-tables** (change). Three changes to the owner's tables, which Task 5 re-renders with scripts/content/render-tables.ts. First, the Kind column prints the question type (likert-5, checklist, gate). So the owner cannot see which six rows OD-08 removes, or which two depend on the gate. Print the kind of SRS 10.1.8 instead. That is follow-up for an id containing -EXTRA-, gate-dependent for a question whose condition names the gate, then gate, checklist or practice. Second, the re-pointed fields table prints 'typed only' for MC-19, which still reads Q-IP-04. Add a column 'Sources after the re-point' that applies C-MAP's rule (units/C-MAP.md:339) to the field's sources in the field maps. MC-19 then reads 'typed; Q-IP-04 status, evidence', MC-20 'typed; Q-IP-06 reason; Q-IP-06 options' and DC-31 'typed'. Third, the proposed answers to OD-08, OD-09 and OD-C3 are shown by stage at the sitting (brief Task 6 timeline). They are in no table, so add a section with the three decision texts to each stage table. The batch hashes do not change, because the payload holds ids and stems only. The tables still say 'Proposal status: draft' and the coverage report 'status=draft'; both refresh when Task 5 re-renders.
