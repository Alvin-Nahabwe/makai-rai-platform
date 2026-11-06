# Template re-check (Task 5 of the C-TPL unit plan)

Independent re-check of the nine HTML templates in `public/templates`, by a reviewer that made
none of the edits. It is the input to the owner's Friday 30 October sitting and to the builder's
commit `fix: apply template review changes`.

- **Reviewed:** branch `unit/c-tpl` at `da686e2`, against base `d13be0c` (`release/0.6.0`).
- **Authority:** SRS `records/plans/2026-10-28-v1-srs.md` (workspace root): TC-1 to TC-7 at lines
  4513-4519, the 10.4.2 findings at lines 4542-4566, the facts of 10.4.3 at lines 4568-4578, the
  writing rules W1 to W10 at lines 3928-3937, the data card and model card maps at lines 4300-4411 (tables at 4316-4361 and 4367-4411).
- **Not judged here:** TC-6, the licence and credit line (Task 6, after `unit/pub`).

## How to read this file

- `stands`: the edit meets the finding and the criteria; no change.
- `change`: the builder applies the exact text below (replace the first block with the second, in
  the file named), then re-runs `npx vitest run __tests__/content/templates.test.ts` and
  `node scripts/content/check-templates-a11y.mjs public/templates`. All 15 changes were applied
  to a scratch copy of the nine files: each replaced text occurs exactly once in its file, and the
  test file run over the copy passes (`Tests  70 passed | 1 todo (71)`), so no pinned string is lost.
- Word counts for W8 (at most 30 words a sentence) count every space-separated word.

## Evidence (run on `da686e2`, 30 October)

| What | Command or method | Result |
|---|---|---|
| Diff, line by line | `git diff d13be0c -- public/templates/<file>` for all nine | read in full; findings below |
| Every added or rewritten sentence | visible text, placeholders and labels of each file compared with `git show d13be0c:<file>`, words counted | 6 sentences over 30 words: 4 newly written (C-11 x2, C-25 x2) and 2 inherited with a small edit (C-02 Local context, C-07 grounding); after the 15 changes only the C-02 one remains (see C-02) |
| Template rules and finding tests | `npx vitest run __tests__/content/templates.test.ts` | `Tests  70 passed \| 1 todo (71)` |
| Accessibility, phone width | `flock .../heavy.lock node scripts/content/check-templates-a11y.mjs public/templates` | every file `serious=0 critical=0 incomplete=0 hscroll=no` at 1280, 360 and 320; exit 0 |
| Printing | C-07, C-17 and C-26 printed to A4 PDF in system Chrome (`page.pdf`, 15 mm margins) and read page by page; the C-07 table measured at 1280, 360 and print widths | C-07 select text clipped (see C-07 R2); C-17 prints to 7 pages (see notes) |
| TC-4 section order | `<h2>` texts of C-17 and C-19 read against SRS 10.3.2 and 10.3.3 | both match the map order, "Record and sign-off" read as "Team sign-off" |
| TC-7 | `grep -n '"/templates/' data/assessmentAreas.json`; `ls public/templates/*.md` | all nine linked from a control; no Markdown file left |
| Uganda statements | `records/uncst2025.txt` lines 26, 2705-2749 | section 16.6 (a) to (f), the clearance sentence (lines 2744-2749) and the in-country server (line 2722) read as quoted below |
| WHO title (unverified in SRS line 4578) | fetched `https://www.who.int/publications/i/item/9789240029200` on 30 October | title "Ethics and governance of artificial intelligence for health", 2021, ISBN 9789240029200 |
| NIST Playbook link used by C-01, C-07, C-26, C-28 | fetched `https://airc.nist.gov/AI_RMF_Knowledge_Base/Playbook` | loads the Playbook landing page, not a redirect or error |
| The 15 changes below | applied to a scratch copy of the nine files (each replaced text found exactly once), then the test file and the Task 4 script run over the copy | `Tests  70 passed \| 1 todo (71)`; every file `serious=0 critical=0 incomplete=0 hscroll=no`, exit 0 |

## Summary

| Template | Findings that stand | Changes | TC-1 | TC-2 | TC-3 | TC-4 | TC-5 | TC-7 |
|---|---|---|---|---|---|---|---|---|
| C-01 | 3 | 0 | pass | pass | pass | pass | pass | pass |
| C-02 | 3 | 1 | pass after change | pass | pass | pass | pass | pass |
| C-07 | 2 | 2 | pass after change | pass | pass | pass | **fail now**, pass after change | pass |
| C-11 | 7 | 6 | pass after changes | pass after change | pass | pass after change | pass after changes | linked; held back until the research-ethics review (Task 7) |
| C-17 | 6 | 1 | pass | pass | pass | pass after change | pass | pass |
| C-19 | 7 | 3 | pass after change | pass | pass | pass after changes; one owner decision | pass | pass |
| C-25 | 4 | 2 | pass | pass | pass | pass | pass after changes | pass |
| C-26 | 4 | 0 | pass | pass | pass | pass | pass | pass |
| C-28 | 5 | 0 | pass | pass | pass | pass | pass | pass |
| **Total** | **41** | **15** | | | | | | |

The edits common to all nine (below) stand and are not counted per template. A finding that stands with a
follow-up `change` (for example C-11 F2 and R1) is counted once on each side.

## Edits common to all nine (SRS line 4542)

| Finding | Verdict | Evidence |
|---|---|---|
| "Review & Approval" or "Review & Sign-off" renamed "Team sign-off", with the TC-2 notice directly under it | stands | test `TC-2: the notice sits directly under the Team sign-off heading` passes x9; the notice is verbatim |
| "Global South consideration" with its emoji replaced by the text label "Local context" | stands | test `TC-5: no emoji, no dash, no curly quote, Local context label` passes x9 |
| Other emoji used as labels removed (C-02 box headings, C-11 warning) | stands | same test |
| Em dashes replaced with a comma, colon or full stop, not a hyphen | stands | diffs show colons and commas; the dash after each C-07 layer number became a full stop ("1. Direct Users") |
| Every form control has an accessible name | stands | the label test passes x9; axe reports no `label` or `select-name` violation |
| `field-sizing: content` on textareas as an enhancement only | stands | `width: 100%` and `min-height` remain the fallback |
| Print button removed, replaced by a one-line hint | stands | the button needed `onclick`, which NFR-SEC-11 forbids (T1 of the unit plan) |

## C-01 Alternatives Analysis

| # | Finding (SRS line 4544) | Verdict |
|---|---|---|
| F1 | TC-1: MAP 1.1 called a "proportionality assessment"; say "draws on" | stands. Grounding now says "draws on NIST AI RMF MAP 1.1" and describes MAP 1.1 as purpose and context, matching 10.4.3 |
| F2 | TC-1: drop the Canada AIA "impact-level approach" claim, or add the levels | stands. Phrase dropped. See owner item 7: the AIA is still cited with no stated use |
| F3 | TC-4: "Final decision" choices fit the record | stands. Options kept, dashes replaced by colons |

TC verdicts: TC-1 pass, TC-2 pass, TC-3 pass, TC-4 pass, TC-5 pass, TC-7 pass.

## C-02 Cost-Benefit & Impact Assessment

| # | Finding (SRS line 4546, 4578) | Verdict |
|---|---|---|
| F1 | TC-2: "Approval status" reads as an approval body's verdict; relabel "The team's decision" with neutral options | stands. Options "Go ahead", "Go ahead with conditions", "Do not go ahead", "Decide later" are neutral |
| F2 | TC-1, TC-3: "Per EU AI Act Art. 27" stated as a duty; reword as one model | stands. Guidance is the SRS wording verbatim; grounding says "as one model" |
| F3 | TC-4: add "Environmental cost: compute, energy and where it runs" (CG-04) | stands. Label verbatim; placeholder is 30 words, at the W8 limit |
| F4 | TC-1 (10.4.3, unverified): the WHO title | **change**. The generic link text names no instrument or year. The title was checked today (Evidence table) |

F4 change, `public/templates/C-02_cost-benefit-impact.html`:

```html
as one model, and on <a href="https://www.who.int/publications/i/item/9789240029200" target="_blank" rel="noopener noreferrer">WHO guidance on AI for health</a> for equity considerations.
```

```html
as one model. For equity, it draws on the WHO guidance <a href="https://www.who.int/publications/i/item/9789240029200" target="_blank" rel="noopener noreferrer">Ethics and governance of artificial intelligence for health (2021)</a>.
```

Left as is: the Local context sentence is 33 words, but only its "LMIC contexts" was spelled out
("low- and middle-income settings"); the length is inherited from `d13be0c`, not added.

TC verdicts: TC-1 pass after F4, TC-2 pass, TC-3 pass, TC-4 pass, TC-5 pass, TC-7 pass.

## C-07 Stakeholder Impact Mapping

| # | Finding (SRS line 4548) | Verdict |
|---|---|---|
| F1 | TC-3: Ugandan examples, village councils, digital exclusion: a strong fit | stands. Kept unchanged |
| F2 | Optional: add "who was consulted, by role, and when" | stands as not done; optional in the SRS (owner item 6) |
| R1 | New, TC-1: the grounding calls the NIST AI RMF MAP function's content "stakeholder identification requirements". The SRS (line 4564, C-28) rules the same wording wrong: the NIST AI RMF is voluntary guidance. The sentence is also 33 words (W8) | **change** |
| R2 | New, TC-5 "prints cleanly", introduced by the edit: the empty option text went from a one-character dash to "Select" at 16 px. In the Power Level and Interest Level columns it shows as "Selec" at 1280 px and as "!" and "Se" when printed (select widths 76 px at 1280, 41 and 53 px at print width, measured) | **change** |

R1 change, `public/templates/C-07_stakeholder-impact-mapping.html`:

```html
This template uses the <strong>Onion Model</strong> of stakeholder analysis (direct users, then affected individuals, then broader society) combined with the <strong>Power-Interest Matrix</strong> and the <a href="https://airc.nist.gov/AI_RMF_Knowledge_Base/Playbook" target="_blank" rel="noopener noreferrer">NIST AI RMF MAP function</a> stakeholder identification requirements.
```

```html
This template uses the <strong>Onion Model</strong> of stakeholder analysis: direct users, then affected individuals, then broader society. It adds the <strong>Power-Interest Matrix</strong> and the guidance on identifying stakeholders in the <a href="https://airc.nist.gov/AI_RMF_Knowledge_Base/Playbook" target="_blank" rel="noopener noreferrer">NIST AI RMF MAP function</a>.
```

R2 change, same file (line 28):

```css
    .stk-table select { border: none; background: transparent; }
```

```css
    .stk-table select { border: none; background: transparent; font-size: 0.82rem; padding: 0.3rem 0; min-inline-size: 4.5rem; }
```

Tested on a copy: "Select" shows whole at 1280 px and at print width; the table is 708 px wide, inside the 716 px section at A4 with Chrome's default margins; the Task 4 script exits 0 on the copy. Acceptance for the builder: the same three checks on the real file. Side effect: 13 px select text, like the C-26 RACI selects (0.78rem), so a phone may zoom when one is focused. Two other layouts were tried and rejected: `table-layout: fixed` broke placeholder words mid-word at 360 px and in print; `field-sizing: fixed` on the table textareas cut their placeholder text.

TC verdicts: TC-1 pass after R1, TC-2 pass, TC-3 pass, TC-4 pass, TC-5 fails now and passes after R2, TC-7 pass.

## C-11 Informed Consent Framework

This template goes to the Sunday 1 November research-ethics review (OD-03) and is held back from
`public/templates` until it passes (Task 7). Every legal statement below is for that review.

| # | Finding (SRS lines 4550-4554) | Verdict |
|---|---|---|
| F1 | TC-1, TC-2: GDPR treated as the governing law ("Per GDPR Art. 13") | stands. No "Per GDPR" remains; GDPR is named only in the grounding |
| F2 | TC-1, TC-2: replace the "Art. 15-22" rights list with the SRS sentence | stands for the sentence (verbatim). **change** R1 for the checklist the builder kept under it |
| F3 | Unverified: dynamic consent attributed to the Research Data Alliance; the H3Africa guideline title | stands. Both claims removed, written without the claim as the unit plan's stop rule asks |
| F4 | TC-2: "must" stated as law becomes "should", with the reason | stands for the wording. **change** R2 and R3: the rewritten sentences break W8 or add a wrong hedge |
| F5 | TC-3: add the national steps teams face, Uganda's 2025 guidelines as the example | stands for content (storage, ownership and national-steps fields added). **change** R4: the instrument is not named (TC-1) and the sentence is 32 words (W8) |
| F6 | TC-3: oral and community consent options stay | stands |
| F7 | TC-4: "Ethics board review reference" uses DC-15's three states | stands for the states ("Approved", "Submitted, awaiting decision", "Not required"). **change** R5: the free-text field misses what DC-15 records with each state (CG-10, SRS line 4268: committee, reference and date; or why not required, and who decided) |
| F8 | Unverified (line 4578): the WHO title | **change** R6, as in C-02; it also splits the grounding sentence, which would otherwise be 32 words |

R1 change (TC-1, TC-2: "often named in data protection laws and ethics guidance" is a general claim nobody checked; the legend should send the reader to their own law), `public/templates/C-11_informed-consent.html`:

```html
<legend>Rights often named in data protection laws and ethics guidance (tick the ones that apply to you)</legend>
```

```html
<legend>Rights to check against your law and ethics approval (tick only those that apply to your participants)</legend>
```

R2 change (W8: 48 words):

```html
<strong>Important:</strong> If the data will be used to train models that make decisions affecting individuals (for example credit scoring or clinical diagnosis), this should be clearly disclosed, and participants should be able to contest such decisions, because otherwise they have no way to correct an error that affects them.
```

```html
<strong>Important:</strong> If the data will train models that make decisions about individuals (for example credit scoring or clinical diagnosis), say so clearly. Participants should be able to contest such decisions, because otherwise they cannot correct an error that affects them.
```

R3 change (TC-2: "In many research settings" implies consent need not be meaningful in others; the old text said "In LMIC contexts"):

```html
In many research settings, consent should be meaningful and not only a signature on a form, because a signature does not show that the person understood.
```

```html
Consent should be meaningful, not only a signature on a form, because a signature does not show that the person understood.
```

R4 change (TC-1 names the instrument as `records/uncst2025.txt:26` gives it; W8; the clearance wording follows lines 2744-2749):

```html
<p class="guidance" id="national-steps-hint">For example, Uganda's 2025 guidelines name consent to use data, algorithmic fairness, data privacy and data ownership among the issues an AI protocol must address, and require data-protection clearance before ethics submission. Name the steps that apply to you.</p>
```

```html
<p class="guidance" id="national-steps-hint">For example, Uganda's National Guidelines for Research Involving Humans as Research Participants (UNCST, 2025) cover AI in section 16.6. They list consent to use data, algorithmic fairness, data privacy and data ownership among the issues an AI protocol must address. They also require data-protection clearance, from the national body for information systems and data protection, before ethics submission. Name the steps that apply to you.</p>
```

R5 change (TC-4, the same text as C-19 R2 so both templates record DC-15 alike):

```html
placeholder="Committee name and reference number, if any"
```

```html
placeholder="Committee name, reference number and date. If not required, say why and who decided."
```

R6 change (F8):

```html
Draws on the information requirements of <a href="https://gdpr-info.eu/art-13-gdpr/" target="_blank" rel="noopener noreferrer">GDPR Articles 13 and 14</a> as one example, on <a href="https://www.who.int/publications/i/item/9789240029200" target="_blank" rel="noopener noreferrer">WHO guidance on AI for health</a>, and on dynamic consent models.
```

```html
Draws on the information requirements of <a href="https://gdpr-info.eu/art-13-gdpr/" target="_blank" rel="noopener noreferrer">GDPR Articles 13 and 14</a>, as one example of a data protection law. It also draws on the WHO guidance <a href="https://www.who.int/publications/i/item/9789240029200" target="_blank" rel="noopener noreferrer">Ethics and governance of artificial intelligence for health (2021)</a> and on dynamic consent models.
```

Checked and left as they are: the rights sentence of section 3 (SRS verbatim, Uganda's Act named as
the example, W6); "Explanation: ... where the law gives this"; the storage and ownership
placeholders; "Consent works best as an ongoing process ..." (18 words, reason given).

TC verdicts: TC-1 pass after R1, R4 and R6; TC-2 pass after R3; TC-3 pass; TC-4 pass after R5;
TC-5 pass after R2 and R4; TC-7 linked from C-11's control, and held back by Task 7 until the
research-ethics review passes.

## C-17 Model Card

| # | Finding (SRS line 4556, map lines 4367-4411) | Verdict |
|---|---|---|
| F1 | TC-4: add evaluation data from the Markdown copy | stands. "Evaluation data and how it differs from training data" (MC-17 wording) |
| F2 | TC-4: fairness metrics with "the team's own threshold", no Pass/Fail | stands. Column "Threshold set by the team"; no pass or fail anywhere |
| F3 | TC-4: section order identical to the generated model card | stands. Sections 1 to 8 match the map; field labels match MC-01 to MC-33 |
| F4 | TC-2: "Values are typed by the team; the platform does not compute them." | stands. Verbatim, under Performance |
| F5 | CG-05: "Version" asks for code, data and model versions | stands |
| F6 | Builder's added structure: "Environmental impact" (MC-33) and "Risks the team accepted" (MC-25) | stands. Both are rows of the map in SRS 10.3.3; without them the TC-4 order test fails |
| R1 | New, TC-4 (line 4516): "No prompt asks for something a generated document already takes from the record without saying so." Many C-17 prompts (for example MC-09, MC-11, MC-21 to MC-28) are filled from the team's recorded decisions, and nothing says so | **change** |

R1 change, `public/templates/C-17_model-card.html` (two sentences of 18 and 21 words, appended to the grounding):

```html
<a href="https://huggingface.co/docs/hub/model-cards" target="_blank" rel="noopener noreferrer">Hugging Face Model Card specification</a>.
```

```html
<a href="https://huggingface.co/docs/hub/model-cards" target="_blank" rel="noopener noreferrer">Hugging Face Model Card specification</a>. The MAK-AI platform's generated model card fills many of these fields from the decisions your team records there. Use this template to draft those answers, or use it on its own if your team does not use the platform.
```

TC verdicts: TC-1 pass, TC-2 pass, TC-3 pass, TC-4 pass after R1, TC-5 pass, TC-7 pass.

## C-19 Datasheet

| # | Finding (SRS line 4558, map lines 4316-4361) | Verdict |
|---|---|---|
| F1 | TC-1: "Gebru et al. (2021); first circulated 2018" everywhere | stands for the string. **change** R1: in the grounding the string sits mid-list, so "first circulated 2018" reads as if it also dates the Hugging Face specification |
| F2 | TC-3: add "Data ownership and benefit-sharing" (DC-30) | stands. Label verbatim |
| F3 | TC-3: add "Where the data is stored" under access | stands. Placeholder names Uganda's in-country server rule as an example (`records/uncst2025.txt:2722`) |
| F4 | TC-4: fold in relationships between instances, known errors, notification of data subjects, contact | stands in the template. See owner item 1: the data card map has no row for any of the four, nor for "Where the data is stored" |
| F5 | CG-18: replace the "C-12 Labeling QA" pointer | stands. Points to the C-04 notebook's labelling agreement and C-12's resources, as CG-18 says; the C-04 notebook specification has the annotator-agreement cell (SRS line 4684) |
| F6 | TC-4: order aligned with 10.3.2 | stands. Sections 1 to 7 match the map; labels match DC-01 to DC-35 |
| F7 | Builder's added structure: DC-35 field and DC-15 three states | stands for both; **change** R2 for the DC-15 free-text placeholder |
| R3 | New, TC-4 (line 4516), as C-17 R1 | **change** |

R1 change, `public/templates/C-19_datasheet.html`:

```html
Adapted from <a href="https://arxiv.org/abs/1803.09010" target="_blank" rel="noopener noreferrer">Gebru et al. (2021); first circulated 2018</a>, "Datasheets for Datasets", and the <a href="https://huggingface.co/docs/hub/datasets-cards" target="_blank" rel="noopener noreferrer">Hugging Face Dataset Card specification</a>.
```

```html
Adapted from "Datasheets for Datasets" by <a href="https://arxiv.org/abs/1803.09010" target="_blank" rel="noopener noreferrer">Gebru et al. (2021); first circulated 2018</a>. Also draws on the <a href="https://huggingface.co/docs/hub/datasets-cards" target="_blank" rel="noopener noreferrer">Hugging Face Dataset Card specification</a>.
```

R2 change (TC-4, DC-15 as CG-10 defines it: "not required (why, and who decided)"):

```html
placeholder="Committee name, reference number, date. If not required, say why."
```

```html
placeholder="Committee name, reference number and date. If not required, say why and who decided."
```

R3 change (two sentences appended to the end of the grounding):

```html
for data collection in African research settings.
```

```html
for data collection in African research settings. The MAK-AI platform's generated data card fills many of these fields from the decisions your team records there. Use this template to draft those answers, or use it on its own if your team does not use the platform.
```

TC verdicts: TC-1 pass after R1, TC-2 pass, TC-3 pass, TC-4 pass after R2 and R3 (owner item 1
still open at field level), TC-5 pass, TC-7 pass.

## C-25 Feedback & Redress

| # | Finding (SRS line 4560) | Verdict |
|---|---|---|
| F1 | TC-1, TC-2: Article 86 stated as a universal right; reword as a model | stands for content: scope matches 10.4.3 ("certain high-risk systems in the EU"). **change** R2: the new guidance sentence is 37 words (W8) |
| F2 | TC-1: Article 85 is a complaint to a market surveillance authority, not to the operator | stands for content. **change** R1: the new grounding sentence is 43 words (W8), and "market surveillance authority" is a technical term left unexplained (W8) |
| F3 | Drop "(per Art. 86)" from the step-3 label | stands |
| F4 | TC-3: non-digital channels, health workers, local leaders | stands. Kept unchanged |

R1 change, `public/templates/C-25_feedback-redress.html`:

```html
Draws on two articles of the EU AI Act as models: <a href="https://artificialintelligenceact.eu/article/86/" target="_blank" rel="noopener noreferrer">Article 86</a> (the right to an explanation of an individual decision, for certain high-risk systems in the EU) and <a href="https://artificialintelligenceact.eu/article/85/" target="_blank" rel="noopener noreferrer">Article 85</a> (the right to lodge a complaint with a market surveillance authority).
```

```html
Draws on two articles of the EU AI Act as models. <a href="https://artificialintelligenceact.eu/article/86/" target="_blank" rel="noopener noreferrer">Article 86</a> gives a right to an explanation of certain decisions made with high-risk AI systems in the EU. <a href="https://artificialintelligenceact.eu/article/85/" target="_blank" rel="noopener noreferrer">Article 85</a> gives a right to complain to a market surveillance authority, a national regulator in the EU.
```

R2 change:

```html
Article 86 of the EU AI Act is one model for a right to ask for an explanation of a decision; consider whether the people your system affects should be able to ask for one, and how.
```

```html
Article 86 of the EU AI Act is one model for a right to ask for an explanation of a decision. Consider whether the people your system affects should be able to ask for one, and how.
```

TC verdicts: TC-1 pass, TC-2 pass, TC-3 pass, TC-4 pass, TC-5 pass after R1 and R2, TC-7 pass.

## C-26 Governance & Accountability RACI

| # | Finding (SRS line 4562) | Verdict |
|---|---|---|
| F1 | TC-1: Clause 5.3 is "Roles, responsibilities and authorities" | stands. Title as 10.4.3 checked it |
| F2 | TC-1: "PMI RACI methodology" overstates; say "the RACI method" | stands |
| F3 | TC-5: 60 drop-downs heavy on a phone, acceptable printed | stands. Each named by row and column; the matrix scrolls in its own region; printed, every cell reads "None" in full (PDF page 2) |
| F4 | TC-3: one person may hold several roles | stands. Kept unchanged |

TC verdicts: all pass (TC-1, TC-2, TC-3, TC-4, TC-5, TC-7). "Legal/Compliance" became "Legal
Adviser", which clears FR-PUB-01 and keeps the role.

## C-28 Codebook & Deployment Documentation

| # | Finding (SRS line 4564, 4566) | Verdict |
|---|---|---|
| F1 | TC-1: NIST AI RMF "requirements"; say "guidance" | stands. FactSheets is no longer called a "standard" either |
| F2 | TC-2: "Audit and compliance schedule" becomes "Review schedule, and the rules that apply" | stands. Label verbatim; placeholder names national rules as the example |
| F3 | TC-3: offline working, power recovery, low-bandwidth interfaces | stands. Kept unchanged |
| F4 | TC-4: links to the model card and datasheet accept an issued document's type, issue date and seal fingerprint | stands |
| F5 | Fold in known failure modes, retraining triggers, version control, tests before deployment | stands. Known failure modes sits under Monitoring; the other three form the new section 7 "Maintenance & Updates" (later sections renumbered). C-28 is not generated in v1 (OD-19), so the extra section breaks no map |

TC verdicts: all pass (TC-1, TC-2, TC-3, TC-4, TC-5, TC-7).

## The three Markdown copies

`codebook-template.md`, `datasheet-template.md` and `model-card-template.md` are deleted after
folding (SRS line 4566): stands. Their prompts that the SRS names are in C-28, C-19 and C-17 as
listed above. Prompts the SRS did not name were not folded (for example the model card copy's
"Assumptions" and "Generalization", the datasheet copy's "Software" and "Potential uses"); that
follows the SRS, which names only the prompts to keep.

## The builder's report, attacked

- **Added structure for TC-4** (C-17 environmental section and accepted risks, C-19 DC-35 and the
  ethics states, C-28 maintenance section): keep. Each C-17 and C-19 addition is a row of the map
  in SRS 10.3.2 or 10.3.3, and D6 (SRS line 4307) makes the document follow the template. The C-28
  section only holds folded prompts.
- **The three unverified facts (SRS line 4578):** H3Africa title and the Research Data Alliance
  attribution were removed: right, per the unit plan's stop rule. The WHO title was replaced by a
  description that named no instrument or year; this re-check fetched the title and asks for it
  (C-02 F4, C-11 R6). The owner confirms it.
- **Legal statements:** C-02 Article 27 (SRS wording verbatim), C-26 clause 5.3 (as checked in
  10.4.3) and C-25 Articles 85 and 86 (scope as checked in 10.4.3) are accurate; C-25 needs only
  the W8 changes. C-11 needs R1 to R6. The Uganda statements in C-11 and C-19 match
  `records/uncst2025.txt` at the lines cited.
- **The Task 4 page counts** ("C-28, 5 A4 pages") are page height divided by A4 height, not
  printed pages. C-17 measures 4467 px ("4 pages") but prints to 7 A4 pages in Chrome, because
  `.section { break-inside: avoid; }` (already at `d13be0c`) starts most sections on a new page and
  leaves half-empty pages. Not a failure of TC-5; the owner may want a shorter print (owner item 8).

## For the owner (Friday sitting)

1. **C-19 fields the data card does not print.** SRS 10.4.2 (line 4558) asks for "relationships
   between instances, known errors, notification of data subjects, contact" as prompts "that the
   data card uses", and for "Where the data is stored". The data card map (SRS 10.3.2, lines
   4316-4361) has no row for any of the five. Either C-MAP adds them to the map, or they stay
   template-only prompts and the SRS sentence is corrected. The section-order test passes either way.
2. **WHO title.** The changes use "Ethics and governance of artificial intelligence for health
   (2021)", from the who.int page fetched on 30 October. Confirm.
3. **C-11 rights checklist** (Sunday, research-ethics review): keep the six tick-boxes under the R1
   legend, or drop them and keep only the SRS sentence and the free-text field.
4. **C-11 grounding names GDPR, not a national law.** It is "one example" and Uganda's Act is named
   in section 3, so W6 holds. Naming Uganda's Act in the grounding would need a check of that Act's
   information duties, which neither the SRS nor this re-check made.
5. **Spelling** (builder's question 4): the three rewritten templates use British spellings, the
   others keep older American ones. Not a TC failure; your choice.
6. **C-07 optional prompt** "who was consulted, by role, and when" (would make C-07 evidence for
   `Q-PO-20`): not added.
7. **C-01 still cites the Canada Algorithmic Impact Assessment** after its "impact-level approach"
   phrase was dropped, but no section says what it draws from it. Keep the citation or drop it.
8. **Print length:** C-17 prints to 7 A4 pages, with sections kept whole. Accept, or ask for
   sections to break across pages.
9. **Legal wording to confirm** (W6: "Legal names are legal's to confirm"): the C-25 gloss "a
   national regulator in the EU" for a market surveillance authority, and the Uganda wording in
   C-11 R4.

## Notes (no change asked)

- C-19's storage placeholder names "Uganda's 2025 national guidelines" in short form; C-11 R4 gives
  the full title. Placeholders vanish once a field is filled, so the short form is acceptable there.
- Printed empty fields show their placeholders, now in #666, and the C-26 RACI legend letters print
  white on an unprinted background (nearly invisible on paper). Both are browser print behaviour,
  not new text.
- C-28 ids are cut from labels (for example `data-storage-location-and-retention-poli`); harmless,
  never shown.
- The EU AI Act and GDPR links go to reproduction sites (artificialintelligenceact.eu,
  gdpr-info.eu), the same sources 10.4.3 used, not to EUR-Lex.
- The TC-4 section-order test is still `it.todo` (it waits for `data/fieldmaps` from C-MAP); the
  order was checked here by hand against the SRS tables.

## Adversarial pass (engineering-skills:adversarial-reviewer)

- **Saboteur:** found C-07 R2 (select text clipped on screen and on paper, introduced by the edit)
  and the misleading Task 4 page counts. WARNING.
- **New hire:** found the C-19 citation that reads as dating the wrong source (R1), the unexplained
  "market surveillance authority" (C-25 R1), the unnamed Uganda instrument (C-11 R4), and the
  truncated C-28 ids. WARNING for the first three, NOTE for the ids.
- **Security auditor:** no new attack surface: no script, handler, frame, form or remote load (the
  NFR-SEC-11 and NFR-PRIV-04 tests pass x9), outbound links are `https` with `rel="noopener
  noreferrer"`. Closest risk: those tests are pattern scans, so they are the only guard until the
  served-page spec of Task 9 runs. NOTE.
- **Verdict:** CONCERNS. No critical finding; the 15 changes above clear the warnings.
