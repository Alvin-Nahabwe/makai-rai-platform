# Re-check of the CW-11 field maps and the UNCST 16.6 table

Independent re-check of `data/fieldmaps/data_card.json`, `model_card.json` and `mitigation_plan.json`
(as committed at 26adbf9) and of `data/uncst-16-6.json` (as committed at b50cd5f), read at branch head
f4b62f3 of `unit/c-map`. Plan: `records/plans/2026-10-29-v1-plan/units/C-MAP.md`, Task 3 Step 1.

Authority: SRS `records/plans/2026-10-28-v1-srs.md` 10.3.1 to 10.3.4 (lines 4289-4435), rules D1 to D9
(lines 4302-4310), OD-20 (line 5635), template review 10.4 (C-17 line 4556, C-19 line 4558); the UNCST
guidelines extract `records/uncst2025.txt:2705-2748` (section 16.6), read with 17.3 Data Ownership
(`records/uncst2025.txt:2771-2779`); the contract `00-contract.md` (`types/documents.ts`, lines 792-814;
module map row `data/uncst-16-6.json`, line 911; Services row `lib/help/uncst.ts`, line 910).

## Result

| Part | Stands | Change |
|---|---|---|
| Fields (78) | 73 | 5: DC-35, DC-30, MC-17, MC-20, MC-33 (label only; no source changes) |
| UNCST issues (6) | 2: (a), (e) | 4: (b), (c), (d), (f) |
| Note of (c) | | reword: its last sentence is not true as written |
| Contract change requests | none | |

Every source, section, order and `typedAddition` value equals its SRS row. The five changes remove an
SRS annotation, "(new field)", that the labels copied from the "Field (template wording)" column and
that would print on every issued data card and model card and on the Help and contact page.

## Method

1. **SRS rows against the JSON, by an independent parser.** The parser in the appendix reads the three
   `GEN:doc_*` tables, turns each Source cell into `FieldSource` values by the transcription key of the
   unit plan (C-MAP.md line 124), takes `typedAddition` from "typed addition allowed" in the Kind cell,
   and compares `fieldId`, `label`, `section`, `sources` (order kept) and `typedAddition` with the JSON.
   It shares no code with the generation or second-root scripts that produced the maps.
   `python3 -I srsdiff.py records/plans/2026-10-28-v1-srs.md .worktrees/v060-C-MAP` printed
   `total diffs 0` over 35, 33 and 10 rows; `homeStage` is `pre-processing`, `in-processing`, `review`
   and `templateVersion` is `5.0.0` in all three files.
2. **Commits.** `git diff --stat 26adbf9 HEAD -- data/fieldmaps __tests__/fixtures/fieldmaps` and
   `git diff --stat b50cd5f HEAD -- data/uncst-16-6.json` print nothing, so the files read are the ones
   those commits made. `cmp` of each map with `__tests__/fixtures/fieldmaps/0.5.0/<type>.json`: identical.
3. **Questions.** All 50 `record` and `record_option` sources checked against `data/questionBank.json`
   (v0.5.0; H0's fixture copy is not merged here): every id exists; `scope` is only on
   `Q-PP-GATE-SENSITIVE` (type `gate`); `options` and every `record_option` are only on `Q-PP-16`,
   `Q-PP-17`, `Q-IP-06`, `Q-IP-13` (type `checklist`); the four option texts ("Missing data analysis",
   "Data lineage/provenance tracking", "Labeling bias", "AUC-ROC curve analysis") are options of their
   question.
4. **Project fields.** The ten names the maps read all exist on `model ProjectMetadata`
   (`prisma/schema.prisma:119-149`); no other project field is read (obligation M1).
5. **Rules D1 to D9.** Each row was read against each rule for anything the key cannot carry (section
   "Rules D1 to D9" below).
6. **UNCST table.** Each issue was read against 16.6 (a) to (f) and the label of every data card and
   mitigation plan field, including fields not listed, and against the printed content of the field
   (the question stems its sources print).
7. **Proposed changes run.** A scratch root outside the repository held copies of both test files, the
   three maps and their baseline copies with the five label changes, and the UNCST table with the
   changes below, plus links to `node_modules` and `prisma`. `vitest run --root <scratch>
   __tests__/content/fieldmaps.test.ts __tests__/content/uncst-table.test.ts -t '^(?!.*in the fixture
   bundle).*$'` printed `Tests 17 passed | 1 skipped (18)` (the skipped case needs `unit/h0`). Putting
   `DC-99` into the scratch table turned two cases red, so the run read the changed files.
8. **Adversarial pass** with `engineering-skills:adversarial-reviewer` (section at the end).

## Field verdicts

Verdicts: **stands**, or **change** with the exact JSON change. A change to a map is made in
`data/fieldmaps/<type>.json` and, identically, in `__tests__/fixtures/fieldmaps/0.5.0/<type>.json`.

### The five changes

The SRS column is headed "Field (template wording)", and D6 (line 4307) says field wording follows the
template the document is based on. "(new field)" records that a field is new relative to the template;
it cannot be the template's own wording. 10.4 gives the template wording for two of them: C-19 adds
"Data ownership and benefit-sharing" (DC-30; line 4558, pinned in C-TPL's test, `units/C-TPL.md:189`)
and C-17 adds "fairness metrics with 'the team's own threshold' instead of 'Pass/Fail'" (MC-20; line
4556). The renderer prints the map's label as the field heading (contract line 889, `ResolvedField.label`;
`units/DOC-a.md:902` "use the map's label"), and PUB's table shows each field by its label with no id
(`units/PUB.md:370`), so the annotation would reach every issued document and the Help and contact page.

| Field | SRS line | Exact JSON change (`label`) |
|---|---|---|
| DC-35 | 4338 | `"Personal or sensitive data, and de-identification (new field)"` to `"Personal or sensitive data, and de-identification"` |
| DC-30 | 4355 | `"Data ownership and benefit-sharing (new field)"` to `"Data ownership and benefit-sharing"` |
| MC-17 | 4389 | `"Evaluation data and how it differs from training data (new field)"` to `"Evaluation data and how it differs from training data"` |
| MC-20 | 4393 | `"Fairness metrics with the team's own threshold (new field; no pass/fail)"` to `"Fairness metrics with the team's own threshold"` |
| MC-33 | 4405 | `"Environmental note: compute and energy (new field)"` to `"Environmental note: compute and energy"` |

After these changes a re-run of the Task 2 second-root diff shows exactly these five label rows; that
difference is the intended one. No test pins a label's text, and the FR-PUB-01 label test still passes
(method step 7).

### Data card (SRS 10.3.2)

| Field | SRS line | Verdict | Note |
|---|---|---|---|
| DC-01 | 4320 | stands | |
| DC-02 | 4321 | stands | typed, then two project sources, in row order |
| DC-03 | 4322 | stands | `typedAddition: true` |
| DC-04 | 4324 | stands | `typedAddition: true` |
| DC-05 | 4325 | stands | The 10.3.1 example for "typed addition allowed" (line 4297) describes this field, but its row's Kind is "typed, project", so a typed source and `typedAddition: false`. Both print the typed and the project value; only their order differs. The row governs |
| DC-06 | 4326 | stands | `typedAddition: true`; see the "Other" observation below |
| DC-07 | 4327 | stands | |
| DC-08 | 4328 | stands | |
| DC-09 | 4329 | stands | `record_option`; `typedAddition: true` |
| DC-10 | 4330 | stands | |
| DC-11 | 4332 | stands | D4 observation below (evidence) |
| DC-12 | 4333 | stands | |
| DC-13 | 4334 | stands | |
| DC-14 | 4335 | stands | `typedAddition: true` |
| DC-15 | 4336 | stands | `structured: "ethics_approval"` |
| DC-16 | 4337 | stands | |
| DC-35 | 4338 | change | label, above; sources stand |
| DC-17 | 4340 | stands | D4 observation below (options) |
| DC-18 | 4341 | stands | |
| DC-19 | 4342 | stands | |
| DC-20 | 4343 | stands | D4 observation below (status, evidence) |
| DC-21 | 4345 | stands | |
| DC-22 | 4346 | stands | |
| DC-23 | 4347 | stands | five sources in row order; `findings` filter `all` on PP-02, PP-03, PP-04, PP-05, PP-07; `typedAddition: true`; label wording "(results typed)" is an owner question below; D4 observation (options) |
| DC-24 | 4349 | stands | |
| DC-25 | 4350 | stands | |
| DC-26 | 4351 | stands | |
| DC-27 | 4352 | stands | |
| DC-28 | 4353 | stands | |
| DC-29 | 4354 | stands | `typedAddition: true`; D4 observation below (option) |
| DC-30 | 4355 | change | label, above; source stands |
| DC-31 | 4357 | stands | |
| DC-32 | 4358 | stands | |
| DC-33 | 4359 | stands | |
| DC-34 | 4360 | stands | |

### Model card (SRS 10.3.3)

| Field | SRS line | Verdict | Note |
|---|---|---|---|
| MC-01 | 4371 | stands | |
| MC-02 | 4372 | stands | |
| MC-03 | 4373 | stands | `typedAddition: true`; see the "Other" observation below |
| MC-04 | 4374 | stands | |
| MC-05 | 4375 | stands | |
| MC-06 | 4376 | stands | |
| MC-07 | 4377 | stands | |
| MC-08 | 4378 | stands | |
| MC-09 | 4380 | stands | The Note column (FR-DOC-05) is not carried; see D3 below |
| MC-10 | 4381 | stands | see the "Other" observation below |
| MC-11 | 4382 | stands | |
| MC-12 | 4384 | stands | |
| MC-13 | 4385 | stands | |
| MC-14 | 4386 | stands | |
| MC-15 | 4387 | stands | |
| MC-16 | 4388 | stands | |
| MC-17 | 4389 | change | label, above; sources stand |
| MC-18 | 4391 | stands | |
| MC-19 | 4392 | stands | |
| MC-20 | 4393 | change | label, above; sources stand |
| MC-21 | 4395 | stands | |
| MC-22 | 4396 | stands | |
| MC-23 | 4397 | stands | `findings` filter `open_and_closed` on IP-01, IP-02, IP-04 |
| MC-24 | 4398 | stands | `mitigations` filter `done`, then the record source |
| MC-25 | 4399 | stands | |
| MC-26 | 4401 | stands | |
| MC-27 | 4402 | stands | `typedAddition: true` |
| MC-28 | 4403 | stands | |
| MC-33 | 4405 | change | label, above; sources stand (record first, typed last, as the row) |
| MC-29 | 4407 | stands | |
| MC-30 | 4408 | stands | |
| MC-31 | 4409 | stands | |
| MC-32 | 4410 | stands | |

### Mitigation plan (SRS 10.3.4)

| Field | SRS line | Verdict | Note |
|---|---|---|---|
| MP-01 | 4421 | stands | label wording "(the team's own words; omitted when empty)" is an owner question below |
| MP-02 | 4422 | stands | `findings` and `mitigations`, both filter `counts`, stage `review` |
| MP-03 | 4424 | stands | |
| MP-04 | 4425 | stands | `mapping` carries no scope; the SRS source names none, the label says "for each open finding", and DOC-b applies it to open findings (`units/DOC-b.md:208`) |
| MP-06 | 4426 | stands | placed before MP-05, as the SRS |
| MP-05 | 4428 | stands | |
| MP-07 | 4430 | stands | |
| MP-08 | 4431 | stands | |
| MP-09 | 4433 | stands | |
| MP-10 | 4434 | stands | |

## Rules D1 to D9: what the key cannot carry

No rule needs a value the maps lack, so none changes a map. Two rules expose a question for the
document generators, recorded here because the maps decide what they meet.

- **D1, D2, D5, D7, D8:** applied by the generator to any source; nothing in a row depends on them.
  D5 holds in the maps: every metric field (MC-18, MC-19, MC-20) has a typed source, DC-23's results are
  a typed addition, and the only computed values are MP-02's whole-number counts.
- **D3:** a record source carries no stage (obligation M3), so the stage comes from the question. The
  SRS Note column ("Q-PP-02 is pre-processing: from that stage's latest seal") is therefore derived, not
  stored; `FieldMapEntry` has no note field and needs none.
- **D4 and `parts` (for the controller and DOC-a; no map change).** D4 (line 4305) says the first field
  fed by a question "prints the full extract and later fields print 'See <field id>'". DOC-a's resolver
  prints "the requested parts" of a record source and tracks repeats per question
  (`units/DOC-a.md:545-546`), and its test pins `DC-11` to contain "See DC-01" (`units/DOC-a.md:518-520`).
  Under that reading, a later field loses what it names but the first field does not print:

  | Question | First field and what it prints | Later field and what it names | Never printed under the per-question reading |
  |---|---|---|---|
  | Q-PP-08 | DC-01: reason | DC-11: reason, evidence | evidence (the collection documents) |
  | Q-PP-16 | DC-09: option "Missing data analysis" | DC-17: options | the list of quality assessments ticked |
  | Q-PP-16 | DC-09 (as above) | DC-29: option "Data lineage/provenance tracking" | whether that option was ticked |
  | Q-PP-12 | DC-19: reason | DC-20: status, evidence | status and evidence (all of DC-20's Q-PP-12 content) |
  | Q-PP-17 | DC-20: option "Labeling bias" | DC-23: options | the list of bias types assessed |

  The other repeats lose nothing: Q-PP-GATE-SENSITIVE (DC-16, DC-35: scope both), Q-PP-14 (DC-35, DC-17:
  status, reason both), Q-PP-21 (DC-26 prints a superset of DC-29's reason), Q-IP-20 (MC-11 prints a
  superset of MC-26's reason). The maps cannot settle this: they hold the parts the SRS names. Either
  "full extract" means the whole decision at first use, or the union of the parts every field of that
  document names, or a later field prints the parts not yet printed. DC-17, DC-20, DC-23 and DC-29 are
  in the UNCST table, so the choice also decides what those rows point at.
- **D6:** the five label changes above.
- **D9 (for DOC-a; no map change):** "Evidence: none attached" is defined for "an extract whose
  decision has no evidence". Whether it prints for a source whose parts leave out evidence (for example
  DC-01, DC-07) follows from the D4 reading above.
- **Observation, "Other" project values (for DOC-a; no map change):** `aiSystemType` (MC-03),
  `deploymentSector` (MC-10) and `datasetType` (DC-06) each have a free-text companion
  (`aiSystemTypeOther`, `deploymentSectorOther`, `datasetTypeOther`, `prisma/schema.prisma:125-137`);
  the dashboard prints the companion when the value is `other` (`components/dashboard/ProjectCard.tsx:31`).
  The SRS rows name the base field only, and DOC-a's `project` resolver prints "value, then
  PROJECT_MARK". A team that chose "Other" would see "other" printed. `datasetSize` (an enum band) and
  `processesPersonalData` (a boolean) also need display words. These are rendering rules for DOC-a and
  need no change to `FieldSource`.

## UNCST 16.6 issues

**Rule applied.** The plan's test (C-MAP.md Task 5 Step 3): a field answers an issue when its label asks
for that content. Where a label describes a process rather than a topic (sampling, labelling), the
question stems its sources print decide, because the table tells a team what its issued document shows
under that heading. The mitigation plan's finding fields (MP-03, MP-05, MP-06) hold every finding of the
stage in its three states, whatever its risk area; their labels ask for risks and the measures against
them, which is issue (b). They are not repeated under a topic issue, because the same reasoning would
put them under every issue a framework risk area covers.

### (a) Consent to use data: **stands**

DC-16 "Informed consent: was consent obtained? How?" asks for exactly this (source Q-PP-13 "Have you
obtained proper informed consent for data collection and use?"). No other label asks for consent.

### (b) Safety and transparency: **change**, remove MP-07

- Remove **MP-07** "Questions of this stage with no decision". Its label asks for the questions the team
  has not decided: gaps in the team's own record, not the safety or transparency of the AI system or its
  data. SRS line 4415 gives MP-07 and MP-08 one purpose ("so the plan shows what the team has not decided
  and what it marked not applicable"), so listing one without the other had no basis.
- DC-21 "Intended uses" and DC-22 "Inappropriate uses": stand (disclosure of use, and misuse).
- DC-31 "Datasheet held by the team": stands, as the weakest fit kept. Its label asks whether the dataset
  is documented in a datasheet (Q-PP-15 "Have you created or referenced a datasheet for your dataset?"),
  which the framework files under its Transparency and Explainability principle (risk area PO-07
  Documentation Deficit, `data/assessmentAreas.json`).
- MP-03, MP-04, MP-05, MP-06: stand. Their labels ask for the open findings with their mitigations, the
  controls suggested for them, the findings closed by a mitigation, and the accepted risks: the risks
  and the measures against them.

### (c) Algorithmic fairness and bias: **change**, add DC-07, remove DC-19, MP-03, MP-05

- Add **DC-07** "Is this a sample or complete collection? How was sampling done?". Sampling is where
  sampling and selection bias arise (risk area PP-05 Sampling and Generalization Bias), and the field's
  only source is Q-PP-18 "Have you assessed whether your data collection methods could introduce
  selection bias?", a bias assessment printed under this heading.
- Remove **DC-19** "How were labels assigned? By whom?". Its label asks for the labelling process, and
  its sources print Q-PP-12 "Have you ensured the quality and consistency of data labels/annotations?"
  and Q-PP-23 "Have you engaged domain experts in reviewing data quality and relevance?": label quality,
  not a bias assessment. The labelling-bias check is DC-20's (Q-PP-17 option "Labeling bias"). DC-19
  moves to (d).
- Remove **MP-03** "Open findings, each with source, risk area, ..." and **MP-05** "Findings closed by a
  mitigation, ...". Their labels ask for every finding of the stage, not for fairness or bias. Keeping
  them on the ground that bias findings may be among them would equally put them under (a) and (e)
  (pre-processing area PP-06 "Privacy & Consent Violations") and put MP-06 under (c), which the table did
  not do. The bias-area findings themselves print in DC-23 (its `findings` source is filtered to PP-02,
  PP-03, PP-04, PP-05, PP-07).
- DC-20 "What quality checks were applied to labels?": stands. Label checks are the framework's measure
  against labelling bias (PP-07), and the field prints the Q-PP-17 "Labeling bias" tick.
- DC-23 "Could the dataset composition negatively affect future uses? Which bias checks were run, and
  their results": stands; the closest fit in the table.

**The note of (c).** The first sentence is true of both documents: the data card's home stage is
pre-processing and it holds no result of a trained model (DC-23 holds bias checks of the data, which
exist before training); a mitigation plan prints findings, mitigations and counts, never a metric value
(D5, line 4306). The second sentence, "The model card holds them once the model is trained", is not true
as written: MC-20 and MC-19 are typed by the team (SRS lines 4392-4393; FR-DOC-03), the platform never
runs evaluations (D5, FR-PUB-04), and an untyped MC-20 prints "Not recorded". As written it reads as if
the platform would hold fairness results. The reworded note keeps both phrases the test requires
("after training", "before training") and matches the C-17 notice of 10.4 (line 4556, "Values are typed
by the team; the platform does not compute them"):

> Fairness results of a trained model exist only after training, so a protocol written before training
> cannot hold them. Once the model is trained, the team types them in the model card; the platform does
> not compute them.

### (d) Data integrity: **change**, add DC-19

- Add **DC-19** "How were labels assigned? By whom?". Who assigned the labels, and how, is the
  provenance of the labels, and its sources print the label quality and domain-expert data quality
  questions (above). Under D4 the Q-PP-12 extract that DC-20 names prints under DC-19, so the integrity
  row needs DC-19 to point at it.
- DC-09 "Missing data: extent and patterns", DC-17 "What preprocessing or cleaning was applied?", DC-18
  "Is the raw (unprocessed) data available?", DC-20 and DC-29 "Retention policy and versioning": stand
  (completeness, the changes made to the data, the original kept, label accuracy, versions and
  provenance). DC-26 "Access controls and geographic restrictions" was considered and not added: the
  guidelines place the integrity of personal data against unlawful access under 16.2 Privacy and
  confidentiality of data (`records/uncst2025.txt:2691-2700`), so it belongs to (e), where it is listed.

### (e) Privacy: **stands**

DC-26 "Access controls and geographic restrictions", DC-29 "Retention policy and versioning" (retention
limits, 16.3, `records/uncst2025.txt:2709-2714`) and DC-35 "Personal or sensitive data, and
de-identification" each ask for privacy content.

### (f) Ownership: **change**, remove DC-02

- Remove **DC-02** "Creators". Its label asks who created the dataset (it prints the project's
  institution and department), not who owns it. The guidelines separate the two: participants "own their data", while institutions are
  custodians who can negotiate its use (17.3, `records/uncst2025.txt:2771-2779`). Listing the creators under ownership reads as if the
  creating institution owned the data.
- DC-30 "Data ownership and benefit-sharing": stands (SRS line 5635, "(f) ownership is DC-30").
- DC-25 "Licence": stands. A licence states the terms of use, which 17.3 puts with ownership: partners
  negotiate ownership and use together.

### The resulting `data/uncst-16-6.json` issue lines

Issues (a) and (e) and `source` are unchanged. Replace the (b), (c), (d) and (f) lines with:

```json
    { "id": "b", "title": "Safety and transparency", "dataCardFields": ["DC-21", "DC-22", "DC-31"], "mitigationPlanFields": ["MP-03", "MP-04", "MP-05", "MP-06"], "note": null },
    { "id": "c", "title": "Algorithmic fairness and bias", "dataCardFields": ["DC-07", "DC-20", "DC-23"], "mitigationPlanFields": [], "note": "Fairness results of a trained model exist only after training, so a protocol written before training cannot hold them. Once the model is trained, the team types them in the model card; the platform does not compute them." },
    { "id": "d", "title": "Data integrity", "dataCardFields": ["DC-09", "DC-17", "DC-18", "DC-19", "DC-20", "DC-29"], "mitigationPlanFields": [], "note": null },
    { "id": "f", "title": "Ownership", "dataCardFields": ["DC-25", "DC-30"], "mitigationPlanFields": [], "note": null }
```

Both test files pass with these lines and the five label changes (method step 7).

## Contract change requests

None. Considered and not needed: `mapping` has no stage or filter, but the SRS source names none and the
scope is MP-04's label (DOC-b applies it to open findings); the D4 and D9 questions are rendering rules
over parts the union already holds; the "Other" companions are a resolver rule over a `project` source.

## For the owner

The owner reviews this table with the field maps at the CW-11 sitting (C-MAP.md Task 5).

1. **The mitigation plan under the topic issues.** Recommended above: MP-03, MP-04, MP-05, MP-06 under
   (b) only, so PUB's table prints "None" in the mitigation plan column of (a), (c), (d), (e), (f). The
   consistent alternative is to list MP-03, MP-05 and MP-06 under every issue a framework risk area
   covers: (a) and (e) through PP-06, (c) through the bias areas. Either is consistent; the earlier
   draft, with two of the three under (c) only, was not.
2. **(c) and (d), DC-07 and DC-19.** Recommended: DC-07 into (c), DC-19 from (c) into (d). The
   alternative read is "a process where a bias arises answers (c)", which would keep DC-19 and still add
   DC-07.
3. **Label wording left as the SRS gives it.** DC-23 ends "(results typed)" and MP-01 ends "(the team's
   own words; omitted when empty)". Both are true on a printed document, so they stand; whether to drop
   them as rendering notes is wording, the owner's. MP-01's "omitted when empty" is how DOC-b renders the
   note (`units/DOC-b.md:208`).

## For the controller

1. The five label changes depart from the plan's key "Labels are the 'Field (template wording)' column
   verbatim" (C-MAP.md Task 2 Step 3) on the ground of D6 and 10.4. Labels only; nothing is issued yet.
2. D4 and `parts` (section above): DOC-a's brief pins the per-question reading in a test; five data card
   fields would print less than their rows name. Settle with DOC-a before its Task 3 test is written.
3. The "Other" companions and the enum and boolean display (section above), for DOC-a.

## Adversarial pass (`engineering-skills:adversarial-reviewer`)

Scope: the three maps and the UNCST table as data that a generator prints and a public page shows.
Verdict: **CONCERNS** on these files (the label and table findings, both settled by the changes above);
the D4 finding is outside these files and is the most serious.

- **Saboteur.** (Critical, DOC-a) The D4 per-question reading drops content five data card fields name
  (DC-11, DC-17, DC-20, DC-23, DC-29); also raised by the New Hire, who reading DC-20 finds "See DC-19"
  pointing at an extract that holds only a reason. (Warning) "(new field)" in five labels prints on every
  issued data card and model card and on the Help and contact page.
- **New Hire.** (Warning) The UNCST table stated no rule, so its membership was inconsistent: MP-03 and
  MP-05 under (c) but not (a) or (e); MP-07 without MP-08; DC-19 but not DC-07. The rule is now stated
  above. (Note) The SRS Note column is not in the JSON; a reader must know that a record source's stage
  is the question's (D3). (Note) No committed test pins the (field, sources) pairs to SRS text; the
  chain is the SRS, this re-check (0 differences over 78 rows), the baseline fixture, then Task 4's test
  that the final maps equal the baseline plus the approved re-points.
- **Security Auditor.** (Warning) Truthfulness (obligation M6): DC-02 under Ownership contradicts 17.3,
  and the note of (c) implied the platform holds fairness results. (Note) The disclosure boundary
  (obligation M1) holds: project sources are the ten names on `ProjectMetadata`, and members' names
  reach a document only through SRS-declared meta items and mitigation owners (D7). The most
  security-relevant assumption left is that free-text reasons hold no personal names, which the reason
  prompts and the S-18 preview own (SRS 10.3.8, W9, UX-20).

## Appendix: the parser used in method step 1

Run as `python3 -I srsdiff.py <SRS file> <worktree>`; it prints one line per row and `total diffs N`.

```python
# Independent re-check parser: SRS 10.3.2-10.3.4 GEN tables -> FieldSource lists, compared to the JSON maps.
import json, re, sys
srs, wt = sys.argv[1], sys.argv[2]
lines = open(srs, encoding='utf-8').read().split('\n')
def table(tag):
    start = next(i for i, l in enumerate(lines) if l.strip() == '<!-- GEN:%s -->' % tag)
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == '<!-- /GEN:%s -->' % tag)
    rows, section = [], None
    for i in range(start + 1, end):
        l = lines[i]
        if not l.startswith('|') or l.startswith('|---') or l.startswith('| Id '):
            continue
        cells = [c.strip() for c in l.strip().strip('|').split('|')]
        if cells[0] == '':
            m = re.fullmatch(r'\*\*(.+)\*\*', cells[1]); section = m.group(1); continue
        rows.append(dict(line=i + 1, id=cells[0], label=cells[1], source=cells[2], kind=cells[3], section=section))
    return rows
def conv(src):
    out = []
    for part in [p.strip() for p in src.split(';') if p.strip()] if '(' not in src else split_top(src):
        out.append(one(part))
    return out
def split_top(s):
    parts, depth, cur = [], 0, ''
    for ch in s:
        if ch == '(': depth += 1
        if ch == ')': depth -= 1
        if ch == ';' and depth == 0:
            parts.append(cur.strip()); cur = ''
        else:
            cur += ch
    if cur.strip(): parts.append(cur.strip())
    return parts
def one(p):
    if p == 'typed': return {'kind': 'typed'}
    if p == 'typed, structured (ethics-approval)': return {'kind': 'typed', 'structured': 'ethics_approval'}
    m = re.fullmatch(r'project: (\w+)', p)
    if m: return {'kind': 'project', 'field': m.group(1)}
    m = re.fullmatch(r'(Q-[A-Z]+-[A-Z0-9-]+) option "(.+)" \(ticked or not; reason\)', p)
    if m: return {'kind': 'record_option', 'questionId': m.group(1), 'option': m.group(2)}
    m = re.fullmatch(r'(Q-[A-Z]+-[A-Z0-9-]+) ((?:status|reason|options|evidence|scope)(?:, (?:status|reason|options|evidence|scope))*)', p)
    if m: return {'kind': 'record', 'questionId': m.group(1), 'parts': m.group(2).split(', ')}
    m = re.fullmatch(r'findings \(stage=([a-z-]+);(.*)\)', p)
    if m:
        stage, rest = m.group(1), m.group(2)
        d = {'kind': 'findings', 'stage': stage}
        areas = None; filt = 'all'
        for tok in [t for t in rest.split(';') if t]:
            if tok.startswith('areas='): areas = tok[6:].split(',')
            else: filt = {'open+closed': 'open_and_closed', 'closed-by-mitigation': 'closed_by_mitigation', 'counts': 'counts', 'open': 'open'}[tok]
        d['filter'] = filt
        if areas: d['areas'] = areas
        return d
    m = re.fullmatch(r'mitigations \(stage=([a-z-]+);(?:status=)?(done|current|counts)\)', p)
    if m: return {'kind': 'mitigations', 'stage': m.group(1), 'filter': m.group(2)}
    m = re.fullmatch(r'accepted risks \(stage=([a-z-]+)\)', p)
    if m: return {'kind': 'accepted_risks', 'stage': m.group(1)}
    if p.startswith('framework mapping'): return {'kind': 'mapping'}
    m = re.fullmatch(r'record metadata \((seal|deciders|review|no-decision|not-applicable)\)', p)
    if m: return {'kind': 'meta', 'item': {'seal': 'seals', 'deciders': 'deciders', 'review': 'review', 'no-decision': 'no_decision', 'not-applicable': 'not_applicable'}[m.group(1)]}
    raise SystemExit('UNPARSED: %r' % p)
bad = 0
for tag, t in [('doc_data_card', 'data_card'), ('doc_model_card', 'model_card'), ('doc_mitigation_plan', 'mitigation_plan')]:
    rows = table(tag)
    m = json.load(open('%s/data/fieldmaps/%s.json' % (wt, t)))
    js = m['fields']
    if [r['id'] for r in rows] != [f['fieldId'] for f in js]:
        print('ORDER DIFF', t); bad += 1
    for r, f in zip(rows, js):
        exp = dict(fieldId=r['id'], label=r['label'], section=r['section'], sources=conv(r['source']), typedAddition='typed addition allowed' in r['kind'])
        got = {k: f[k] for k in exp}
        flag = 'same' if exp == got else 'DIFF'
        if flag == 'DIFF':
            bad += 1; print('DIFF', t, r['line'], exp, got)
        print('%s line %d %s %s' % (t, r['line'], r['id'], flag))
    print(t, len(rows), 'rows; json keys', sorted(m.keys()), m['homeStage'], m['templateVersion'])
print('total diffs', bad)
```
