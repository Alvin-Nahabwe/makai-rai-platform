# Question set 5.0.0, pre-processing: proposed revision

Proposal status: revised. Base: d13be0c data/questionBank.json (sha256 18e39eb8f4e0cbfbffb79bd4da15fb38ccc0ac704b70fa13f3bb14813e66b009).

24 questions in v0.5.0, 22 proposed: keep 21, reword 0, merge 2, cut 0, replace 1.

| Id | Kind | Action | Reason | New stem or survivor |
|---|---|---|---|---|
| Q-PP-01 | practice | keep | The only question on whether AI is needed at all; one of two questions on PP-01, the thinnest risk area (10.1.9). |  |
| Q-PP-02 | practice | keep | Defining the problem and its success criteria is a distinct practice; PP-01 is thin, and it feeds DC-21 and MC-09. |  |
| Q-PP-03 | practice | keep | Identifying who is affected is the base the later questions on groups and consultation build on; feeds MC-10. |  |
| Q-PP-04 | practice | keep | Effects on protected or vulnerable groups. Merging Q-PP-05 into it was considered and rejected: a rights assessment covers more than group effects. |  |
| Q-PP-05 | practice | keep | A human rights impact assessment asks about the rights of everyone affected, not only groups (Q-PP-04); its expected practice will be scaled to the risk (W3). |  |
| Q-PP-06 | practice | replace | The stem describes the team's members, not a practice, so it cannot carry a status (OD-C3, 10.1.6). The practice question of worked example 2 changes what done means, so under R-61 it is a new id in the same series; the mapping stays PP-03, PP-04 (QC-02). | Q-PP-24: Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks? |
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

## Document fields re-pointed in this stage

| Document | Field | Label | Old source | New source | Sources after the re-point |
|---|---|---|---|---|---|
| data_card | DC-31 | Datasheet held by the team | Q-PP-15 | typed only | typed |
| model_card | MC-12 | Dataset name | Q-PP-15 | Q-PP-08 | typed; Q-PP-08 evidence |
| model_card | MC-15 | Geographic scope and demographic composition | Q-PP-10 | Q-PP-09 | Q-PP-09 status, reason; project: country |

## Proposed decisions

**OD-08.** Proposed: none of the six follow-up questions stays a question of its own. Shown to every team, each asks a practice that another question of its stage already asks, so each is merged into that question, which takes the union of both mappings: Q-IP-EXTRA-01 into Q-IP-04, Q-IP-EXTRA-02 into Q-IP-08, Q-PO-EXTRA-01 into Q-PO-17, Q-PO-EXTRA-02 into Q-PO-20, Q-PO-EXTRA-03 into Q-PO-07, Q-PO-EXTRA-04 into Q-PO-14. The mechanism of FR-CNT-06 is built as written (OD-22 (a)): no unlock rules, every question shown to every team, Q-IP-06 always shown. With no follow-up kept, the QC-06 help-text rule applies to no question.

**OD-09.** Proposed: keep the gate and all five checklists, each recorded as one decision (FR-CNT-03, FR-CNT-04 as built, OD-22 (a)). The gate Q-PP-GATE-SENSITIVE stays a scope answer (yes, no, not sure) that raises no finding and decides whether Q-PP-13 and Q-PP-14 apply. The checklists Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13 and Q-PO-11 keep their stems and options; Q-IP-06 absorbs Q-IP-05, because a checklist's status already records which measures fit the project.

**OD-C3.** Proposed: replace Q-PP-06 with the practice question of worked example 2 under the new id Q-PP-24, mapped like Q-PP-06 (PP-03, PP-04). Under R-61 a rewording that changes what done means takes a new id, and this one does: the old stem asked how diverse the team is, the new one whether the team found and filled the perspectives the problem needs. Revision 0.5 proposed a reword that keeps the id Q-PP-06; keeping it would need your explicit choice to set R-61 aside for this question. Its why-this-is-asked text names C-20 Multi-stakeholder Consultation (CG-19).

Batch hash (question-set:pre-processing, SHA-256 of the canonical JSON of its 22 approved stems): `3996fee4a4e4b120f417151cdbeca27f08c954c19632a1e92d14156b5d1f1a20`
