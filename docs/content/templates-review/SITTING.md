# Sitting: the nine document templates

For the product owner. Prepared by C-TPL on branch `unit/c-tpl` (head before this pack: `784faccd`). Nothing here has been approved. Your pass is tied to the exact files whose hashes are at the end.

## How to answer

- One line for all: **"Pass all nine"**.
- Or one line per template: **"C-xx: pass"**, **"C-xx: change <what>"**, or **"C-xx: hold back"**.
- C-11 may be held back. The release can be tagged without it (A13); it then stays out of `public/templates` and is not linked.
- Answer Q1 to Q5 below too. "Q1 to Q5 as proposed" is enough if you accept the defaults.
- If you ask for a change, the file changes, its hash changes, and you pass the new hash.

## The nine templates

Open each with the `file://` address in a browser. Print pages are from Chrome at A4.

| Template | File | Open | Print pages | What changed from the original | Re-check verdict |
|---|---|---|---|---|---|
| C-01 Alternatives Analysis | `public/templates/C-01_alternatives-analysis.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-01_alternatives-analysis.html` | 3 | Says it draws on NIST MAP 1.1 (purpose and context), no longer a "proportionality assessment"; Canada impact-level claim dropped.<br>Labels added to every field; "Local context" replaces the emoji label. | Stands. TC-1 to TC-5, TC-7 pass. Open: Canada AIA still cited (Q5 item c). |
| C-02 Cost-Benefit and Impact Assessment | `public/templates/C-02_cost-benefit-impact.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-02_cost-benefit-impact.html` | 5 | "Approval status" became "The team's decision" (Go ahead, Go ahead with conditions, Do not go ahead, Decide later); EU Article 27 shown as one model; environmental cost prompt added.<br>WHO guidance named with title and year. | Stands after one change (WHO title), applied. |
| C-07 Stakeholder Impact Mapping | `public/templates/C-07_stakeholder-impact-mapping.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-07_stakeholder-impact-mapping.html` | 3 | Kept as it was (Ugandan examples); NIST AI RMF called guidance; drop-downs made wide enough to read; labels on table cells.<br>The optional "who was consulted" prompt is not added (Q5 item a). | Stands after two changes (NIST wording, drop-down size), applied. Drop-downs checked in print. |
| C-11 Informed Consent Framework | `public/templates/C-11_informed-consent.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-11_informed-consent.html` | 6 | GDPR is no longer the governing law; rights are "under the law that applies to you"; Uganda 2025 guidelines named as the example; ethics status has three states.<br>Added ownership, storage and national-steps prompts. Needs the research-ethics reviewer. | Stands after six changes, applied. TC-1 to TC-4 pass. Can be held back (Q3). |
| C-17 Model Card | `public/templates/C-17_model-card.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-17_model-card.html` | 7 | Sections now follow the model card the platform issues; evaluation data and fairness metrics added with the team's own threshold, no pass or fail.<br>Environmental impact and accepted risks added; the old Markdown copy removed. | Stands after one change (says the platform fills many fields from the record), applied. |
| C-19 Datasheet for Datasets | `public/templates/C-19_datasheet.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-19_datasheet.html` | 7 | Sections now follow the data card the platform issues; ownership, storage, ethics status and the Gebru citation added; the old Markdown copy removed.<br>Five prompts have no data card row (Q2). | Stands after three changes (citation, ethics note, record note), applied. |
| C-25 Feedback and Redress | `public/templates/C-25_feedback-redress.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-25_feedback-redress.html` | 5 | EU Articles 85 and 86 shown as models with their scope, not as universal rights; "market surveillance authority" explained in plain words.<br>Non-digital channels kept. | Stands after two changes (sentence length, plain words), applied. |
| C-26 Governance and Accountability RACI | `public/templates/C-26_governance-raci.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-26_governance-raci.html` | 3 | "RACI method" replaces "PMI RACI methodology"; ISO 42001 clause 5.3 title checked.<br>All 60 drop-downs named by row and column; the matrix scrolls on a phone. | Stands, no change asked. |
| C-28 Codebook and Deployment Documentation | `public/templates/C-28_codebook-deployment.html` | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-TPL/public/templates/C-28_codebook-deployment.html` | 6 | NIST AI RMF called guidance; "Review schedule, and the rules that apply" replaces the audit label.<br>New section 7 Maintenance and Updates (retraining, version control, tests); the old Markdown copy removed. | Stands, no change asked. |

Every template also now: says it is the team's own record and not an approval (the notice under "Team sign-off"); has no emoji or dashes; names every field for screen readers; works at phone width; ends with the platform credit line. The check by axe-core (accessibility rules) shows no serious problems at 1280, 360 and 320 px.

## Questions for you

**Q1. Three facts the SRS marks unverified (line 4578).**
- The H3Africa guideline title: removed. C-11 no longer cites it.
- Dynamic consent attributed to the Research Data Alliance: removed. C-11 says "dynamic consent models" with no attribution.
- The WHO guidance title: used as "Ethics and governance of artificial intelligence for health" (2021; ISBN 9789240029200), in C-02 and C-11. Fetched from who.int on 30 October.
- Proposed: keep the WHO title as written; leave the other two out.

**Q2. C-19: five prompts with no data card row.** The data card the platform issues (SRS 10.3.2) has no row for: relationships between instances, known errors, notification of data subjects, contact, and where the data is stored. They are in the template because SRS line 4558 asks for them. Either they stay as template-only prompts, or they are dropped.
- Proposed: keep them as template-only prompts, and correct the SRS sentence. The section-order test passes either way.

**Q3. C-11: the rewritten legal statements.** None was researched beyond the SRS (10.4.2, 10.4.3) and `records/uncst2025.txt`. They need the research-ethics reviewer. The statements, in full:
1. Grounding: "Draws on the information requirements of GDPR Articles 13 and 14, as one example of a data protection law. It also draws on the WHO guidance Ethics and governance of artificial intelligence for health (2021) and on dynamic consent models."
2. Section 3: "List the rights your participants have under the law that applies to you (for example Uganda's Data Protection and Privacy Act 2019) and under your ethics approval." Then six tick-boxes (withdraw, access, erasure, explanation "where the law gives this", contest, object) under "Rights to check against your law and ethics approval (tick only those that apply to your participants)".
3. Section 2 warning: "If the data will train models that make decisions about individuals (for example credit scoring or clinical diagnosis), say so clearly. Participants should be able to contest such decisions, because otherwise they cannot correct an error that affects them."
4. Section 1, national steps: "For example, Uganda's National Guidelines for Research Involving Humans as Research Participants (UNCST, 2025) cover AI in section 16.6. They list consent to use data, algorithmic fairness, data privacy and data ownership among the issues an AI protocol must address. They also require data-protection clearance, from the national body for information systems and data protection, before ethics submission. Name the steps that apply to you."
5. Section 4: "Consent should be meaningful, not only a signature on a form, because a signature does not show that the person understood."
6. Ethics status: Approved / Submitted, awaiting decision / Not required, with "Committee name, reference number and date. If not required, say why and who decided."

Evidence: statement 4 rests on `records/uncst2025.txt` lines 2727-2745 (the AI issues list, section 16.6, and the clearance sentence); the in-country storage rule in C-19 rests on line 2722 (section 16.3); the full range is 2705-2750. The GDPR and Data Protection and Privacy Act 2019 names come from SRS 10.4.3; the Act's own text was not checked.
- Proposed: pass C-11 only after the research-ethics reviewer has read items 1 to 6, or hold C-11 back.
- Also yours: keep the six rights tick-boxes, or drop them and keep only the sentence and the free-text field (proposed: keep).

**Q4. The credit line link label "Licence terms" (owner question B6).** Each template ends with the platform credit text from `data/credit.json` ("This platform draws on Responsible AI Assessments, Parts A to C, by GIZ (FAIR Forward), licensed under CC BY-SA 4.0. Changes were made.") followed by a link to the licence page, labelled "Licence terms". The label is the builder's, not yours.
- Proposed: keep "Licence terms", or give the wording you prefer.

**Q5. Other items for you** (from the re-check, "For the owner"):
- (a) C-07 optional prompt "who was consulted, by role, and when". Not added. Proposed: leave out.
- (b) Spelling: C-17, C-19 and C-28 use British spellings (licence, labelling); the others keep older ones. Proposed: leave as is.
- (c) C-01 still cites Canada's Algorithmic Impact Assessment, with no sentence on what it draws from it. Keep or drop. Proposed: drop the citation.
- (d) C-17 prints to 7 pages with sections kept whole. Proposed: accept.
- (e) C-25 calls a market surveillance authority "a national regulator in the EU"; a lawyer should confirm this and the Uganda wording in C-11. Proposed: have the legal reviewer confirm before release.
- (f) The new structure in C-17 (environmental impact, accepted risks), C-19 (DC-35, ethics states) and C-28 (section 7) is needed for the section order of the issued documents. Proposed: keep.
- (g) Printed empty fields show their placeholder text (browser behaviour); the C-26 legend letters are nearly invisible on paper. Not changed.

## Batch hash: the files as they stand

SHA-256 of each file, so your pass is for these exact bytes. (If C-11 is held back, its file moves unchanged to `docs/content/templates-review/` and keeps this hash.)

| Template | sha256 |
|---|---|
| C-01 | `4f029a26f4048f501103b51b70c0648d2b8bb4bc94b5d56dc3e275552ccbddd4` |
| C-02 | `05db63996ed71078e0a9dd4a76aceb3568c946f7156db289e605f03853aaf086` |
| C-07 | `2ab7e2c7995237ca055c34b960d3dd88ac84202c9e35c6e0716b13c9a8c438e4` |
| C-11 | `737331f112679cb01a393e9affc0073b0e72aaa1dbdb5e4c6843f77d868504b3` |
| C-17 | `ca930c6327239d01aeb7f48abfbe579ef5e4f74be170eeab0610bf9cd32e8f26` |
| C-19 | `b078ab38addaada17d28700df05e92c6dfb2c116a13b46087c8b69ba6c6f1d7f` |
| C-25 | `7341a13b53f02478f35517abf52749e0faeed028234be5140d83283f267980eb` |
| C-26 | `abb2157415de818e07dd54436e378df8c853d0c16689f9e4fdd50e53bcfc06b9` |
| C-28 | `277ebffe57fb39305e1f05abdf89baae8bb93ce9bf5b454adf8de3b11cb437f3` |
