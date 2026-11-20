# Review: the risk mapping for content 5.2.0

For the domain experts who approve the risk mapping, and for the product owner. Drafted on 20 November 2026 from content 5.1.0 at commit f4d3c186.

**This is a draft.** Nothing in it is approved. Content 5.1.0 stays the running version, and no 5.2.0 files exist. Every row below is a proposal: you accept it, edit it or decline it.

## Why you are asked

The owner's rule for content is "I draft, experts approve". The question page and the working report can suggest controls ("Ways teams address this"), but they stay hidden until you sign a `risk-mapping` record. Until then the working report shows risk areas only: "Areas now, controls later".

The design names three links that are wrong today: Q-IP-21 → IP-06, Q-PO-13 → PO-05 and Q-PO-22 → PO-03. A reviewer's sample of 22 questions found the suggested controls wrong or partly wrong for about half (audit evidence `B-content.md` §4). A wrong suggestion on the report is worse than none, because the report is what teams share.

## What you sign

One record covers three things together (`lib/content/signoffs.ts:26-30` and `60-82`):

1. **Each question's risk areas** (`gaps`), in order. The order matters. The first area is the heading the question sits under in the working report's next steps (`lib/documents/workingReport.ts:44-54`), and only that area's controls are listed there.
2. **Each checklist option's risk areas** (`optionGapMap`), for the five checklists.
3. **Each risk area's controls**, with every control's name, type, description and links (title, address and type). If any of that text changes after you sign, the record stops matching and the controls are hidden again.

Some things are shown with a control but are not part of what you sign:

- "Also helps with", followed by the names of other areas that list the same control (`components/suggestions/ControlCard.tsx:86-87`). Area names are not in the record.
- "Usually applied in", followed by a stage. It comes from the area's stage (`ControlCard.tsx:89`, `lib/content/suggestions.ts:50`).
- The notebook and template linked to a control, which come from `data/resources.json` (`ControlCard.tsx:76-77`).
- The `role` written next to each checklist option's area (primary, supporting, supplementary). The record keeps area ids only. Apart from the content check's shape test (`validate.ts:314-316`), no code in `lib/`, `components/` or `app/` reads the role.

Whether the record should cover these too is a decision for the 5.2.0 release (see the release notes below).

## Limits this draft works within

- The content check requires exactly 21 risk areas and 28 controls (`lib/content/validate.ts:31-32`, FR-CNT-01). The draft adds no control and removes none.
- Every area must be reached by a question, and every control by an area (`validate.ts:381-397`). The proposal passes both; the check at the end proves it.
- The sensitive-data gate maps to no area (FR-CNT-04).
- Controls belong to an area, so every question in that area is offered the same controls. Much of what the audit sample found wrong comes from this: a question in the right area still gets the area's other controls. This draft fixes wrong control lists and wrong question → area links. Suggesting controls per question would change how the platform works, which is outside this review.
- Where nothing among the 28 fits, the row says so, and the practice is listed under "What no control covers". The draft does not invent a control.

## How to answer

Reply with one line per row you want to settle:

- `Q-IP-21: accept`, `PO-03: accept` or `C-10: accept` puts the proposal in 5.2.0.
- `PO-03: edit C-25, C-26, C-28` or `Q-PP-24: edit PP-03, PP-04` puts your version in 5.2.0.
- `Q-PO-11 / Audit trail/logging: decline` keeps the 5.1.0 value.

"Accept every keep row" is also an answer. A row left unanswered stays open, and nothing is signed until every row is settled. Rows marked **low** confidence, or that say "unsure" or "Experts:", are the ones that most need your judgment.

## Summary

| What | Rows | Proposed change | Keep |
|---|---|---|---|
| Risk area → controls | 21 | 9 | 12 |
| Control text | 28 | 1 | 27 |
| Question → risk areas | 67 | 21 | 46 |
| Checklist option → risk areas | 41 | 3 | 38 |

A question row marked keep can still show different controls, because an area it maps to changes. That is true of 21 keep rows; the question table shows both lists.

Of the 88 question and area rows, 41 are marked high confidence, 40 medium and 7 low.

In 5.1.0, 62 of the 67 questions have a non-empty `gaps`. The other five are the gate and four checklists. Five questions have an `optionGapMap`: Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13, Q-PO-11. Q-IP-06 has both: `gaps: ["IP-01"]` and an option map.

## The three known faults

**Q-IP-21** (version control). Areas now IP-06; proposed IP-06. Controls now C-17, C-18, C-19; under the proposal C-17, C-19, C-28.
The area is right: IP-06's own text names "code versioning" first. The fault was IP-06's control list, which offered explainability (C-18). The IP-06 row swaps it for C-28, which documents dependencies and configuration. This is still only a partial fit, because none of the 28 controls is version control.

**Q-PO-13** (retirement plan). Areas now PO-05; proposed PO-03, PO-05. Controls now C-02, C-26; under the proposal C-25, C-26, C-02, C-01.
Retiring a system is mostly a decision about who decides and how users and data are handled, which is accountability (PO-03). PO-05 stays second, because the question's good practice text asks the plan to count "the computing and energy the system uses while running". No control is about retirement.

**Q-PO-22** (data protection compliance). Areas now PO-03; proposed PP-06, PO-03. Controls now C-21, C-25, C-26; under the proposal C-09, C-10, C-11, C-25, C-26.
PP-06's own text ends "compliance with national data protection laws", and it brings data governance (C-09), anonymisation (C-10) and consent (C-11). PO-03 stays second for "ethical guidelines", and the PO-03 row removes drift monitoring (C-21) from it.

**The audit sample.** `B-content.md` §4 judged 22 questions. Its table marks 6 as fitting, 5 as weak and 11 as wrong or partly wrong, although its tally line says 7, 5 and 10; the rows are used here. What the draft does for each row that did not fit:

| Question | Audit verdict | Controls now | Under the proposal | What the draft does |
|---|---|---|---|---|
| Q-PP-02 | WEAK | C-01, C-02, C-20 | C-01, C-02, C-20 | Kept. No control covers a problem statement; listed under what no control covers. |
| Q-PP-03 | PARTLY WRONG | C-03, C-05, C-07 | C-03, C-05, C-07 | Kept. C-07 fits; C-03 and C-05 stay because PP-04 is the right area and controls attach per area. |
| Q-PP-05 | WEAK | C-03, C-04, C-06, C-05, C-07 | C-03, C-04, C-06, C-05, C-07 | Kept, marked unsure, with a question for you about C-02. |
| Q-PP-07 | WEAK | C-02, C-26 | C-02, C-01 | C-26 goes and C-01 comes in (PO-05 row). |
| Q-PP-08 | WEAK | C-17, C-19, C-26, C-28 | C-17, C-19, C-28 | C-26 goes (PO-07 row). C-17 and C-28 stay as related documentation. |
| Q-PP-20 | PARTLY WRONG | C-03, C-04, C-05, C-21, C-22, C-23 | C-03, C-04, C-05, C-21, C-22, C-23 | Kept. C-23 stays because PO-01 is a right area and controls attach per area. |
| Q-PP-21 | PARTLY WRONG | C-09, C-10, C-11, C-21, C-25, C-26 | C-09, C-10, C-11, C-25, C-26 | C-21 (drift) goes (PO-03 row). C-25 (redress) stays. |
| Q-IP-03 | WRONG | C-13, C-17, C-18 | C-13, C-14, C-17 | C-18 goes and C-14 comes in (IP-04 row). Still no control about error types. |
| Q-IP-10 | WRONG for C-18 | C-17, C-18, C-19 | C-17, C-19, C-28 | C-18 goes and C-28 comes in (IP-06 row). |
| Q-IP-11 | WEAK | C-03, C-09, C-10 | C-03, C-09 | C-10 goes (IP-07 row). |
| Q-IP-16 | WRONG | C-13, C-17, C-18 | C-01, C-02, C-20 | Remapped to PP-01, which brings C-01. |
| Q-IP-18 | WRONG | C-13, C-15, C-18 | C-13, C-14, C-17 | Remapped to IP-04 to match Q-IP-13. Still no calibration control. |
| Q-IP-21 | WRONG | C-17, C-18, C-19 | C-17, C-19, C-28 | Area kept; IP-06's controls fixed. Still partial. |
| Q-IP-22 | WRONG | C-13, C-15, C-18, C-03, C-09, C-10 | C-14, C-21, C-03, C-09 | Kept, marked low. IP-05 and IP-07 lose their wrong controls; nothing fits security testing. |
| Q-PO-13 | WRONG mapping | C-02, C-26 | C-25, C-26, C-02, C-01 | PO-03 added in front of PO-05. |
| Q-PO-22 | WRONG | C-21, C-25, C-26 | C-09, C-10, C-11, C-25, C-26 | PP-06 added in front of PO-03. |


## Risk areas and their controls

One row per risk area. A control change here reaches every question in the area: the last column lists them.

| Area | Name | Controls now | Proposed | Change | Why | Confidence | Questions that reach it |
|---|---|---|---|---|---|---|---|
| PP-01 | Techno-solutionist Bias | C-01, C-02, C-20 | C-01, C-02, C-20 | keep | C-01, C-02 and C-20 are the three practices PP-01's own `mitigated` text names: alternatives analysis, cost-benefit evaluation, stakeholder consultation. | high | Q-PP-01, Q-PP-02, Q-PP-24, Q-IP-16, Q-IP-09 |
| PP-02 | Data Scarcity & Availability Bias | C-03, C-04, C-05 | C-03, C-04, C-05 | keep | C-03 (completeness) and C-05 (who is missing) match PP-02's "completeness audits, representativeness analysis". C-04 (biases in how data was collected) is a weaker fit for data that is too sparse; kept because nothing closer exists. | medium | Q-PP-09, Q-PP-16, Q-PP-17, Q-PP-18, Q-PP-20, Q-PP-22, Q-PP-23 |
| PP-03 | Historical & Societal Bias | C-03, C-04, C-06 | C-03, C-04, C-06 | keep | C-04 (biases baked into the data) and C-06 (protected groups) are PP-03's "contextual bias analysis, protected group identification"; C-03 covers the representativeness side. | high | Q-PP-04, Q-PP-05, Q-PP-24, Q-PP-11, Q-PP-16, Q-PP-17, Q-PP-19 |
| PP-04 | Population Bias | C-03, C-05, C-07 | C-03, C-05, C-07 | keep | C-07 (stakeholder mapping), C-05 (distribution) and C-03 (representativeness) are PP-04's "stakeholder mapping, deployment context analysis, and cross-population validation". | high | Q-PP-03, Q-PP-04, Q-PP-05, Q-PP-24, Q-PP-09, Q-PP-16, Q-PP-17, Q-PP-22, Q-PO-24 |
| PP-05 | Sampling & Generalization Bias | C-03, C-05, C-08 | C-03, C-05, C-08 | keep | C-08 (sampling strategy), C-05 and C-03 are PP-05's "stratified sampling … balanced data collection". | high | Q-PP-09, Q-PP-16, Q-PP-17, Q-PP-18, Q-IP-02 |
| PP-06 | Privacy & Consent Violations | C-09, C-10, C-11 | C-09, C-10, C-11 | keep | C-09, C-10 and C-11 are PP-06's "informed consent protocols, data anonymization techniques, access controls". | high | Q-PP-13, Q-PP-14, Q-PP-21, Q-PO-11, Q-PO-22 |
| PP-07 | Labeling Bias | C-03, C-04, C-12 | C-03, C-04, C-12 | keep | C-12 (labelling QA) is PP-07's "inter-rater reliability … labeling guidelines"; C-04 covers "who labeled it" and C-03 label accuracy. | high | Q-PP-12, Q-PP-17, Q-PP-23 |
| IP-01 | Algorithmic Discrimination | C-13, C-14, C-15 | C-13, C-14, C-15 | keep | C-13, C-14 and C-15 are IP-01's "fairness metrics evaluation, subgroup analysis, and bias mitigation techniques", in that order. | high | Q-IP-04, Q-IP-06, Q-IP-13, Q-IP-15, Q-IP-19, Q-PO-17 |
| IP-02 | Aggregation Bias | C-13, C-14, C-16 | C-13, C-14, C-16 | keep | C-14 (disaggregated) and C-16 (stratified or separate models) are IP-02's "disaggregated analysis … separate models"; C-13 measures the subgroup gap. | high | Q-IP-02, Q-IP-04, Q-IP-06, Q-IP-13, Q-IP-14, Q-IP-19, Q-PO-12 |
| IP-03 | Opacity & Unexplainability | C-17, C-18, C-19 | C-17, C-18 | change | Drop C-19. A datasheet documents the data, and IP-03 is about decisions nobody can explain; its `mitigated` text names explainability methods and model documentation (C-18, C-17). C-19 stays reached through IP-06 and PO-07. | medium | Q-IP-01, Q-IP-07, Q-IP-17, Q-IP-09, Q-IP-20 |
| IP-04 | Metric Selection Bias | C-13, C-17, C-18 | C-13, C-14, C-17 | change | Swap C-18 for C-14. IP-04's `mitigated` text is "contextual metric selection, multi-metric evaluation"; C-14 (break performance down by subgroup) is multi-metric evaluation, while C-18 (why the model decides) is not about which metric is used. No control is about choosing or reporting error measures (confusion matrix, precision, recall); see the gaps list. | medium | Q-IP-01, Q-IP-03, Q-IP-04, Q-IP-18, Q-IP-13, Q-IP-15 |
| IP-05 | Model Robustness Failure | C-13, C-15, C-18 | C-14, C-21 | change | Replace C-13, C-15 and C-18, none of which tests robustness: fairness metrics, debiasing and explanations. C-14 (performance by subgroup, here by condition or site) and C-21 (catching data drift) are the nearest of the 28 to IP-05's "robustness testing … sensitivity analysis". C-13, C-15 and C-18 stay reached through IP-01 and IP-03. None of the 28 controls is a robustness, stress or security test. This row trades three wrong controls for two partial ones; the experts may prefer a new control (see the gaps list). | low | Q-IP-08, Q-IP-17, Q-IP-13, Q-IP-22, Q-IP-24 |
| IP-06 | Reproducibility Failure | C-17, C-18, C-19 | C-17, C-19, C-28 | change | Swap C-18 for C-28. IP-06's `mitigated` text is "code versioning, experiment tracking, documentation standards, and model cards"; C-28 documents dependencies and configuration, and explainability (C-18) has nothing to do with reproducing a result. No control covers version control or experiment tracking, which IP-06's own text names first; see the gaps list. | medium | Q-IP-10, Q-IP-12, Q-IP-21, Q-PO-11 |
| IP-07 | Data Integrity Compromise | C-03, C-09, C-10 | C-03, C-09 | change | Drop C-10. IP-07 is "data corruption, unauthorized modification"; anonymisation (C-10) does not prevent either. C-03 (accuracy checks) and C-09 (who may access and change data) match "integrity checks, access controls". C-10 stays reached through PP-06. No control is a data-validation pipeline or audit log, which IP-07's text names. | medium | Q-PP-16, Q-IP-11, Q-IP-22, Q-PO-11 |
| PO-01 | Deployment Drift | C-21, C-22, C-23 | C-21, C-22, C-23 | keep | C-21 (drift detection), C-22 (retraining) and C-23 (staged rollout) are PO-01's "continuous monitoring … scheduled retraining … drift detection". | high | Q-PP-20, Q-IP-24, Q-PO-01, Q-PO-02, Q-PO-16, Q-PO-17, Q-PO-18, Q-PO-12, Q-PO-14, Q-PO-23 |
| PO-02 | Lack of Human Oversight | C-21, C-24, C-25 | C-21, C-24, C-25 | keep | C-24 (a human can review, override or shut down) is PO-02's core; C-21 supports "validation" and C-25 the override route for people affected. | medium | Q-PO-03, Q-PO-05, Q-PO-07, Q-PO-18, Q-PO-14, Q-PO-21 |
| PO-03 | Accountability Gap | C-21, C-25, C-26 | C-25, C-26 | change | Drop C-21. PO-03 is "no clear ownership … when the AI system produces harmful or incorrect outputs"; drift monitoring is not ownership. C-26 (accountability matrix) and C-25 (redress) match "accountability matrices, incident response". C-21 stays reached through PO-01, PO-02 and IP-05. Its text names incident response plans and governance frameworks; no control is an incident-response plan. | medium | Q-PP-21, Q-PO-04, Q-PO-05, Q-PO-11, Q-PO-13, Q-PO-22, Q-PO-23 |
| PO-04 | User Literacy Deficit | C-24, C-25, C-27 | C-24, C-25, C-27 | keep | C-27 (user training) is PO-04's "user training programs"; C-24 and C-25 cover knowing when to override and how to complain. C-25 is the weakest of the three. | medium | Q-PO-06, Q-PO-07, Q-PO-15, Q-PO-21, Q-PO-24 |
| PO-05 | Environmental Impact | C-02, C-26 | C-02, C-01 | change | Swap C-26 for C-01. PO-05 is energy and carbon cost; C-26 (who is responsible) does not address it. C-02 lists CodeCarbon among its resources, and C-01 (would a simpler approach do) is PO-05's "efficient model architectures". C-26 stays reached through PO-03. | medium | Q-PP-07, Q-PO-13 |
| PO-06 | Feedback Loop Absence | C-24, C-25, C-27 | C-24, C-25, C-20 | change | Swap C-27 for C-20. PO-06's `mitigated` text is "feedback platforms, appeal mechanisms, community engagement, and regular stakeholder consultations"; C-20 is multi-stakeholder consultation, while user training (C-27) belongs to PO-04, which still reaches it. This changes Q-PO-09, which the audit sample judged FITS with C-24, C-25 and C-27; it would get C-24, C-25 and C-20. | medium | Q-PO-08, Q-PO-09, Q-PO-11, Q-PO-20 |
| PO-07 | Documentation Deficit | C-17, C-19, C-26, C-28 | C-17, C-19, C-28 | change | Drop C-26. PO-07's own description lists "model cards, datasheets, codebooks, and deployment specifications": exactly C-17, C-19 and C-28. An accountability matrix is not system documentation. C-26 stays reached through PO-03. | high | Q-PP-08, Q-PP-16, Q-IP-12, Q-IP-20, Q-PO-10, Q-PO-11, Q-PO-15 |

## Control text as people see it

The card on the question page and the working report show this text. You approve it with the mapping. The links were not opened while drafting (no network).

| Control | Name | Type | Description | Links (title, type, address) | Proposed |
|---|---|---|---|---|---|
| C-01 | Alternatives Analysis | procedural | Before building an AI system, ask whether a simpler approach (rules, heuristics, manual process) would work just as well. | NIST AI RMF Playbook: MAP function (framework): https://airc.nist.gov/airmf-resources/playbook/map/<br>Canada Algorithmic Impact Assessment (AIA) Tool (framework): https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/algorithmic-impact-assessment.html | keep |
| C-02 | Cost-Benefit & Impact Assessment | procedural | Weigh the expected benefits of deploying AI against its costs and potential harms to affected people. | EU AI Act Art. 27: Fundamental Rights Impact Assessment (framework): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689<br>WHO Ethics & Governance of AI for Health (framework): https://www.who.int/publications/i/item/9789240029200<br>NIST AI RMF Playbook: MAP function (framework): https://airc.nist.gov/airmf-resources/playbook/map/<br>CodeCarbon: track the energy use and carbon emissions of computing (tool): https://docs.codecarbon.io/latest/ | keep |
| C-03 | Data Quality & Representativeness Audit | technical | Check whether your training data is complete, accurate, and actually represents the people the model will affect. | pandas: working with missing data (tool): https://pandas.pydata.org/docs/user_guide/missing_data.html<br>SciPy: chi-square test against expected counts (stats.chisquare) (tool): https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.chisquare.html | keep |
| C-04 | Bias Detection in Data | technical | Look for biases baked into the data: how it was collected, who labeled it, and what got measured. | scikit-learn: mutual_info_classif (tool): https://scikit-learn.org/stable/modules/generated/sklearn.feature_selection.mutual_info_classif.html<br>scikit-learn: cohen_kappa_score (tool): https://scikit-learn.org/stable/modules/generated/sklearn.metrics.cohen_kappa_score.html<br>statsmodels: fleiss_kappa (tool): https://www.statsmodels.org/stable/generated/statsmodels.stats.inter_rater.fleiss_kappa.html | keep |
| C-05 | Data Distribution Analysis | technical | Compare how different groups are represented in your data. Who is overrepresented? Who is missing? | pandas: crosstab (tool): https://pandas.pydata.org/docs/reference/api/pandas.crosstab.html<br>SciPy: statistics reference (scipy.stats) (tool): https://docs.scipy.org/doc/scipy/reference/stats.html | keep |
| C-06 | Protected Group Identification | procedural | Who could be harmed by this system? Identify the protected and vulnerable groups in your specific deployment context. | NIST SP 1270: Towards a Standard for Identifying and Managing Bias in AI (framework): https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1270.pdf<br>IBM AI Fairness 360 (AIF360): Bias Detection Toolkit (tool): https://aif360.readthedocs.io/en/stable/<br>Microsoft Fairlearn: Fairness Assessment & Mitigation (tool): https://fairlearn.org/main/user_guide/index.html | keep |
| C-07 | Stakeholder Impact Mapping | procedural | Identify everyone affected by the AI system (direct users, subjects of decisions, and communities) then map how each group could be helped or harmed. | NIST AI RMF Playbook, MAP 5.1: impacts, beneficial and harmful (framework): https://airc.nist.gov/airmf-resources/playbook/map/<br>OECD AI Principles: Inclusive Growth & Stakeholder Engagement (framework): https://oecd.ai/en/ai-principles | keep |
| C-08 | Sampling Strategy Design | procedural | Document how you will sample data to avoid over- or under-representing any group. | scikit-learn: Cross-validation & Stratified Sampling (tool): https://scikit-learn.org/stable/modules/cross_validation.html<br>NIST AI RMF Playbook, MAP 2.3: data collection and selection (framework): https://airc.nist.gov/airmf-resources/playbook/map/ | keep |
| C-09 | Data Governance Framework | informational | Set clear rules for how data is collected, stored, accessed, and eventually retired. | NIST AI RMF Playbook: GOVERN function (framework): https://airc.nist.gov/airmf-resources/playbook/govern/<br>OECD AI Principles: Data Governance & Stewardship (framework): https://oecd.ai/en/ai-principles<br>DAMA International: Data Management Body of Knowledge (DMBOK) (framework): https://www.dama.org/cpages/body-of-knowledge | keep |
| C-10 | Privacy & Anonymization Protocols | technical | Remove or mask personal identifiers so individuals cannot be re-identified from the data. | pycanon: k-anonymity and l-diversity checks in Python (tool): https://pypi.org/project/pycanon/<br>Python: hmac, keyed-hash message authentication (tool): https://docs.python.org/3/library/hmac.html | change: name → "Privacy & Anonymisation Protocols". British spelling, matching Q-PP-14's "anonymisation" (5.1.0 spelling mix noted in the audit, B-content.md §8). Description unchanged. |
| C-11 | Informed Consent Framework | procedural | People whose data you use should know what they are consenting to, in language they can understand. | WHO Ethics & Governance of AI for Health: Consent Guidance (framework): https://www.who.int/publications/i/item/9789240029200<br>UNESCO Recommendation on Ethics of AI: Informed Participation (framework): https://www.unesco.org/en/artificial-intelligence/recommendation-ethics<br>GDPR Articles 13-14: Information Requirements for Consent (framework): https://gdpr-info.eu/art-13-gdpr/<br>Regulation (EU) 2016/679 (GDPR), official text (framework): https://eur-lex.europa.eu/eli/reg/2016/679/oj | keep |
| C-12 | Labeling Quality Assurance | procedural | When humans label data, check that different labelers agree. Write clear guidelines and measure inter-rater reliability. | scikit-learn: cohen_kappa_score (tool): https://scikit-learn.org/stable/modules/generated/sklearn.metrics.cohen_kappa_score.html<br>statsmodels: fleiss_kappa (tool): https://www.statsmodels.org/stable/generated/statsmodels.stats.inter_rater.fleiss_kappa.html<br>Label Studio: Open-Source Data Annotation Platform (tool): https://labelstud.io/ | keep |
| C-13 | Subgroup Fairness Metrics | technical | Measure fairness (statistical parity, predictive parity, etc.) for each subgroup. Numbers that look fine overall can hide disparities. | Fairlearn: assessing fairness with MetricFrame (tool): https://fairlearn.org/main/user_guide/assessment/index.html | keep |
| C-14 | Disaggregated Performance Analysis | technical | Break down model performance by subgroup. A model that works well on average can fail specific populations. | Fairlearn: MetricFrame (tool): https://fairlearn.org/main/api_reference/generated/fairlearn.metrics.MetricFrame.html<br>scikit-learn: resample (tool): https://scikit-learn.org/stable/modules/generated/sklearn.utils.resample.html | keep |
| C-15 | Bias Mitigation Techniques | technical | Use techniques like reweighting, adversarial debiasing, or fairness constraints to reduce bias during model training. | Fairlearn: mitigation techniques (CorrelationRemover, ExponentiatedGradient, ThresholdOptimizer) (tool): https://fairlearn.org/main/user_guide/mitigation/index.html | keep |
| C-16 | Stratified Model Evaluation | technical | Sometimes one model cannot serve everyone well. Check whether separate models or stratified approaches would be fairer. | scikit-learn: StratifiedKFold (tool): https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.StratifiedKFold.html<br>scikit-learn: GroupKFold (tool): https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html | keep |
| C-17 | Model Documentation (Model Card) | procedural | Write a model card: what the model does, how well it performs, where it fails, and who might be affected. | Mitchell et al. (2019): Model Cards for Model Reporting (paper): https://doi.org/10.1145/3287560.3287596<br>Google Model Card Toolkit (tool): https://github.com/tensorflow/model-card-toolkit<br>Hugging Face: Model Card Guide (tool): https://huggingface.co/docs/hub/model-cards<br>DVC: data and model versioning (tool): https://doc.dvc.org/<br>MLflow: experiment and model tracking (tool): https://mlflow.org/docs/latest/ml/<br>Git: reference documentation (tool): https://git-scm.com/docs<br>EQUATOR Network: reporting guidelines library (guidance): https://www.equator-network.org/reporting-guidelines/<br>TRIPOD+AI reporting guideline (guidance): https://www.equator-network.org/reporting-guidelines/tripod-statement/ | keep |
| C-18 | Explainability Analysis | technical | Use SHAP, LIME, or feature importance to understand why the model makes the decisions it does. | SHAP documentation (tool): https://shap.readthedocs.io/en/latest/<br>scikit-learn: permutation feature importance (tool): https://scikit-learn.org/stable/modules/permutation_importance.html<br>Adversarial Robustness Toolbox (GitHub) (tool): https://github.com/Trusted-AI/adversarial-robustness-toolbox | keep |
| C-19 | Dataset Documentation (Datasheet) | procedural | Write a datasheet: how the data was collected, what it contains, how it was processed, and what it should (and should not) be used for. | Gebru et al. (2021): Datasheets for Datasets (paper): https://arxiv.org/abs/1803.09010<br>Hugging Face: Dataset Card Guide (tool): https://huggingface.co/docs/hub/datasets-cards<br>EQUATOR Network: reporting guidelines library (guidance): https://www.equator-network.org/reporting-guidelines/ | keep |
| C-20 | Multi-stakeholder Consultation | procedural | Bring affected communities and diverse voices into the design and evaluation process, not just at the end. | UNESCO Recommendation on Ethics of AI: Multi-stakeholder Governance (framework): https://www.unesco.org/en/artificial-intelligence/recommendation-ethics<br>OECD AI Principles: Inclusive Growth & Sustainable Development (framework): https://oecd.ai/en/ai-principles<br>AU Continental AI Strategy: Multi-stakeholder Governance (framework): https://au.int/en/documents/20240809/continental-artificial-intelligence-strategy | keep |
| C-21 | Monitoring & Drift Detection | technical | Models degrade over time. Set up monitoring to catch performance drops and data drift before they cause harm. | SciPy: two-sample Kolmogorov-Smirnov test (stats.ks_2samp) (tool): https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ks_2samp.html<br>Evidently documentation (tool): https://docs.evidentlyai.com/introduction | keep |
| C-22 | Scheduled Retraining Protocols | procedural | Define when to retrain: what performance thresholds trigger it, who approves it, and how you validate the new version. | NIST AI RMF Playbook: MANAGE function (framework): https://airc.nist.gov/airmf-resources/playbook/manage/<br>Google Cloud: MLOps, continuous delivery and automation pipelines in machine learning (guidance): https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning | keep |
| C-23 | A/B Testing & Canary Deployment | procedural | Roll out gradually. Canary deployments and A/B tests catch problems before they reach everyone. | NIST AI RMF Playbook, MANAGE 1.1: whether deployment should proceed (framework): https://airc.nist.gov/airmf-resources/playbook/manage/<br>CONSORT-AI reporting guideline (guidance): https://www.equator-network.org/reporting-guidelines/consort-artificial-intelligence/<br>SPIRIT-AI reporting guideline (guidance): https://www.equator-network.org/reporting-guidelines/spirit-artificial-intelligence/<br>Google SRE Workbook: canarying releases (guidance): https://sre.google/workbook/canarying-releases/ | keep |
| C-24 | Human-in-the-Loop Design | procedural | Make sure a human can review, override, or shut down the AI when it gets things wrong. | NIST AI RMF Playbook, MANAGE 2.4: supersede, disengage or deactivate a system (framework): https://airc.nist.gov/airmf-resources/playbook/manage/<br>EU AI Act: Human Oversight Requirements for High-Risk AI (framework): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689 | keep |
| C-25 | Feedback & Redress Mechanisms | procedural | Give people a way to challenge AI decisions that affect them, and make the process accessible. | EU AI Act Art. 86: Right to Explanation of AI Decisions (framework): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689<br>UNESCO Recommendation: Contestability & Redress Mechanisms (framework): https://www.unesco.org/en/artificial-intelligence/recommendation-ethics<br>OECD AI Principles: Accountability & Transparency (framework): https://oecd.ai/en/ai-principles | keep |
| C-26 | Governance & Accountability Matrix | procedural | Who is responsible when something goes wrong? Assign roles, responsibilities, and accountability up front. | NIST AI RMF Playbook, GOVERN 2.1: roles and responsibilities (framework): https://airc.nist.gov/airmf-resources/playbook/govern/<br>ISO/IEC 42001: AI Management System Standard (framework): https://www.iso.org/standard/81230.html | keep |
| C-27 | User Training & Literacy Programs | informational | End-users need to understand what the AI does and does not do. Build training that covers both capabilities and limitations. | OECD AI Policy Observatory: AI Literacy & Education (framework): https://oecd.ai/en/ai-principles<br>UNESCO Recommendation: AI Education & Public Awareness (framework): https://www.unesco.org/en/artificial-intelligence/recommendation-ethics<br>Elements of AI: a free online introduction to artificial intelligence (guidance): https://www.elementsofai.com/ | keep |
| C-28 | Codebook & Deployment Documentation | procedural | Document the deployment: architecture, dependencies, configuration, and what to do when things break. | NIST AI RMF Playbook, MANAGE 4.1: incident response, recovery and change management (framework): https://airc.nist.gov/airmf-resources/playbook/manage/ | keep |

## Questions

One row per question, in the order the platform asks them. "Areas now" and "Proposed" list the areas in order, and the first one heads the working report. For a checklist, the areas are the union of its options' areas (see the next table). "Controls shown" is what the question page offers before any option is ticked; "same" means the list does not change.

| Question | Stage | Question text | Areas now | Proposed | Controls shown now | Under the proposal | Change | Why | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| Q-PP-01 | pre-processing | Have you checked whether AI is the best approach, compared with simpler options such as a statistical model, a set of rules or a manual process? | PP-01 | PP-01 | C-01, C-02, C-20 | same | keep | "checked whether AI is the best approach … simpler options" is PP-01 (techno-solutionist bias) and C-01 (alternatives analysis) word for word. | high |
| Q-PP-02 | pre-processing | Have you clearly defined the problem your AI system aims to solve, including specific objectives and success criteria? | PP-01 | PP-01 | C-01, C-02, C-20 | same | keep | "defined the problem … objectives and success criteria" belongs in problem formulation, where PP-01 says the bias is introduced. No control covers writing a problem statement or success measures; C-02 is the nearest. Needs a control the 28 do not have (problem statement and success criteria). | medium |
| Q-PP-03 | pre-processing | Have you identified all stakeholders who are directly or indirectly affected by the AI system? | PP-04 | PP-04 | C-03, C-05, C-07 | same | keep | "identified all stakeholders" is PP-04's first mitigation (stakeholder mapping) and C-07. The area also shows C-03 and C-05, which are data audits; that is the cost of controls attaching per area. | medium |
| Q-PP-04 | pre-processing | Have you assessed how the AI system might affect protected or vulnerable groups, for example by gender, age, ethnicity, disability or income? | PP-03, PP-04 | PP-03, PP-04 | C-03, C-04, C-06, C-05, C-07 | same | keep | "affect protected or vulnerable groups" is C-06 (protected group identification) under PP-03 and C-07 under PP-04. | high |
| Q-PP-05 | pre-processing | Have you conducted a human rights impact assessment for the AI system? | PP-03, PP-04 | PP-03, PP-04 | C-03, C-04, C-06, C-05, C-07 | same | keep | A human rights impact assessment touches PP-03 (societal harm) and PP-04 (who is served), so the areas stand. Unsure: no impact-assessment control is reached; C-02, whose resources include the EU AI Act Art. 27 assessment, sits only under PP-01 and PO-05. Experts: add C-02 to PP-03, map this question to PP-01 as well, or accept that no control fits. | low |
| Q-PP-24 | pre-processing | Have you checked which perspectives the problem needs (disciplines, lived experience, gender, language and culture of the people affected) and brought in the ones your team lacks? | PP-03, PP-04 | PP-03, PP-04, PP-01 | C-03, C-04, C-06, C-05, C-07 | C-03, C-04, C-06, C-05, C-07, C-01, C-02, C-20 | change | "checked which perspectives the problem needs … brought in the ones your team lacks" is C-20 (multi-stakeholder consultation), and PP-01's `mitigated` text names "stakeholder consultation during problem definition". This is CG-19, which the 5.0.0 sitting deferred as a mapping change (SITTING-1.md:424). PP-01 goes last so the report heading stays PP-03. | medium |
| Q-PP-07 | pre-processing | Have you estimated the energy use and carbon cost of the proposed AI system? | PO-05 | PO-05 | C-02, C-26 | C-02, C-01 | keep | "energy use and carbon cost" is PO-05's definition, and C-02 lists CodeCarbon. Under the PO-05 row it suggests C-02 and C-01 instead of C-02 and C-26. | high |
| Q-PP-08 | pre-processing | Have you documented the data sources, collection methods, and rationale for data selection? | PO-07 | PO-07 | C-17, C-19, C-26, C-28 | C-17, C-19, C-28 | keep | "documented the data sources" is PO-07 (documentation deficit), and C-19 (datasheet) is the practice. Under the PO-07 row C-26 drops out; C-17 and C-28 remain as related documentation. | medium |
| Q-PP-09 | pre-processing | Have you assessed whether your training data is representative of the target population? | PP-02, PP-04, PP-05 | PP-04, PP-05, PP-02 | C-03, C-04, C-05, C-07, C-08 | C-03, C-05, C-07, C-08, C-04 | change | Same areas, new order. "representative of the target population" is PP-04's definition (design population does not match the population served), so PP-04 should head the report, not PP-02 (data too sparse). | medium |
| Q-PP-11 | pre-processing | Have you checked whether any input could stand in for a sensitive attribute (for example, village standing in for ethnicity), and decided what to do about it? | PP-03 | PP-03 | C-03, C-04, C-06 | same | keep | "input could stand in for a sensitive attribute" is a route for historical and societal bias (PP-03); C-04 and C-06 fit. IP-01 (algorithmic discrimination) would also fit; the experts may want it second. | medium |
| Q-PP-12 | pre-processing | Have you checked that the data labels are correct and consistent? | PP-07 | PP-07 | C-03, C-04, C-12 | same | keep | "data labels are correct and consistent" is PP-07 and C-12 (labelling QA). | high |
| Q-PP-GATE-SENSITIVE | pre-processing | Does your data contain information that could identify a person, or other sensitive personal information? | (none) | (none) | (none) | same | keep | The gate decides whether Q-PP-13 and Q-PP-14 apply. A gate maps to no risk area (validate.ts, FR-CNT-04), so it stays empty. | high |
| Q-PP-13 | pre-processing | Have you obtained proper informed consent for data collection and use? | PP-06 | PP-06 | C-09, C-10, C-11 | same | keep | "informed consent" is PP-06 and C-11. | high |
| Q-PP-14 | pre-processing | Have you removed or replaced the details in your data that could identify a person (anonymisation or pseudonymisation)? | PP-06 | PP-06 | C-09, C-10, C-11 | same | keep | "removed or replaced the details … that could identify a person" is PP-06 and C-10. | high |
| Q-PP-16 | pre-processing | Which of the following data quality assessments have you performed? | options: PP-02, IP-07, PP-05, PP-03, PP-04, PO-07 | options: PP-02, IP-07, PP-05, PP-03, PP-04, PO-07 | C-03, C-04, C-05, C-09, C-10, C-08, C-06, C-07, C-17, C-19, C-26, C-28 | C-03, C-04, C-05, C-09, C-08, C-06, C-07, C-17, C-19, C-28 | keep | A checklist: its areas come from the options (see the option table). `gaps` stays empty. | high |
| Q-PP-17 | pre-processing | Which of the following bias types have you assessed for in your data? | options: PP-03, PP-04, PP-05, PP-07, PP-02 | options: PP-03, PP-04, PP-05, PP-07, PP-02 | C-03, C-04, C-06, C-05, C-07, C-08, C-12 | same | change | A checklist: its areas come from the options (see the option table). `gaps` stays empty. | high |
| Q-PP-18 | pre-processing | Have you assessed whether your data collection methods could introduce selection bias? | PP-02, PP-05 | PP-05, PP-02 | C-03, C-04, C-05, C-08 | C-03, C-05, C-08, C-04 | change | Same areas, new order. "collection methods could introduce selection bias" is PP-05's definition (non-random or uneven sampling), so PP-05 should head the report. | medium |
| Q-PP-19 | pre-processing | Have you evaluated whether historical patterns in the data reflect past discrimination or systemic inequities? | PP-03 | PP-03 | C-03, C-04, C-06 | same | keep | "historical patterns … reflect past discrimination" is PP-03's definition. | high |
| Q-PP-20 | pre-processing | Have you checked whether your training data is recent enough for the time the system will be used? | PP-02, PO-01 | PP-02, PO-01 | C-03, C-04, C-05, C-21, C-22, C-23 | same | keep | "recent enough for the time the system will be used" is data relevance (PP-02) and drift (PO-01). PO-01 also brings C-23 (canary rollout), which does not fit a pre-processing check; that is the cost of controls attaching per area. | medium |
| Q-PP-21 | pre-processing | Have you established data governance policies covering access, sharing, and retention? | PP-06, PO-03 | PP-06, PO-03 | C-09, C-10, C-11, C-21, C-25, C-26 | C-09, C-10, C-11, C-25, C-26 | keep | "data governance policies covering access, sharing, and retention" is C-09 under PP-06. Under the PO-03 row, drift (C-21) drops out and C-26 (who decides, by role) remains. | medium |
| Q-PP-22 | pre-processing | Have you checked whether your data has enough examples of rare cases and conditions? | PP-02, PP-04 | PP-02, PP-04 | C-03, C-04, C-05, C-07 | same | keep | "enough examples of rare cases" is data scarcity (PP-02) and the served population (PP-04). | high |
| Q-PP-23 | pre-processing | Have you engaged domain experts in reviewing data quality and relevance? | PP-07, IP-02 | PP-07, PP-02 | C-03, C-04, C-12, C-13, C-14, C-16 | C-03, C-04, C-12, C-05 | change | Swap IP-02 for PP-02. "domain experts … reviewing data quality and relevance" is label checking (PP-07) and relevance (PP-02: data "not relevant to the problem"). Aggregation bias (IP-02) is about pooling groups in a model, not about expert review. | medium |
| Q-IP-01 | in-processing | Have you written down why you chose this type of model for your problem and your data? | IP-03, IP-04 | IP-03, IP-04 | C-17, C-18, C-19, C-13 | C-17, C-18, C-13, C-14 | keep | "why you chose this type of model" touches opacity (IP-03: "selecting interpretable models where appropriate") and IP-04. Unsure: IP-04 is about evaluation metrics, not model choice; C-17 (model card) is the useful control there. Experts: keep IP-04, or replace it with PP-01 so C-01 (alternatives) is suggested. | low |
| Q-IP-02 | in-processing | Have you ensured that training, validation, and test datasets are representative of the same underlying population? | IP-01, IP-02 | PP-05, IP-02 | C-13, C-14, C-15, C-16 | C-03, C-05, C-08, C-13, C-14, C-16 | change | Swap IP-01 for PP-05 and lead with it. "training, validation, and test datasets are representative of the same underlying population" is generalisation (PP-05: "causing models to generalize poorly"), with C-05 and C-08 as the practices. Discrimination (IP-01) is not what this question checks. Unsure: the split question has no exact area; PP-05 is a pre-processing area, so its controls show "Usually applied in Pre-processing". | low |
| Q-IP-03 | in-processing | Have you measured the different kinds of error your model makes, for example with a confusion matrix, precision, recall, specificity and F1? | IP-04 | IP-04 | C-13, C-17, C-18 | C-13, C-14, C-17 | keep | "different kinds of error your model makes" is metric choice (IP-04). Under the IP-04 row it suggests C-13, C-14 and C-17 instead of C-13, C-17 and C-18; C-14 is the nearest. No control is about measuring error types; see the gaps list. | medium |
| Q-IP-04 | in-processing | Have you calculated performance metrics separately for each relevant subgroup (e.g., by age, gender, ethnicity)? | IP-01, IP-02, IP-04 | IP-01, IP-02, IP-04 | C-13, C-14, C-15, C-16, C-17, C-18 | C-13, C-14, C-15, C-16, C-17 | keep | "performance metrics separately for each relevant subgroup" is C-14, reached through IP-01 and IP-02, and C-13. | high |
| Q-IP-06 | in-processing | Which fairness metrics have you computed? | options: IP-01, IP-02 | options: IP-01, IP-02 | C-13, C-14, C-15, C-16 | same | keep | Fairness metrics are IP-01 (C-13). Its `gaps` (IP-01) always shows; the options add IP-02 for the conditional metrics. | high |
| Q-IP-07 | in-processing | Have you applied explainability methods (e.g., SHAP, LIME, feature importance) to understand model decisions? | IP-03 | IP-03 | C-17, C-18, C-19 | C-17, C-18 | keep | "explainability methods (e.g., SHAP, LIME …)" is C-18 under IP-03 word for word. | high |
| Q-IP-08 | in-processing | Have you tested the model on data that differs from its training data, such as noisy, incomplete or unusual inputs? | IP-05, IP-03, IP-06 | IP-05 | C-13, C-15, C-18, C-17, C-19 | C-14, C-21 | change | Drop IP-03 and IP-06. "tested the model on data that differs from its training data" is IP-05 (robustness). IP-03 and IP-06 came only from the 5.0.0 merge rule (SITTING-1.md:422), not from the question; reproducibility and opacity are not what it asks. | medium |
| Q-IP-16 | in-processing | Have you compared your model's performance against a simple baseline (e.g., majority class, logistic regression)? | IP-04 | PP-01 | C-13, C-17, C-18 | C-01, C-02, C-20 | change | Replace IP-04 with PP-01. "compared … against a simple baseline" tests whether the complexity is justified, which is PP-01 and C-01. Under IP-04 it was offered fairness metrics, a model card and explainability (audit sample: WRONG). | medium |
| Q-IP-17 | in-processing | Have you checked whether the model relies on shortcuts in the data that will not hold in real use? | IP-03, IP-05 | IP-03, IP-05 | C-17, C-18, C-19, C-13, C-15 | C-17, C-18, C-14, C-21 | keep | "relies on shortcuts in the data" is IP-05 (breaks when data shifts) found with explanations (IP-03, C-18). | medium |
| Q-IP-18 | in-processing | Have you checked whether the model's confidence matches how often it is right? | IP-05 | IP-04 | C-13, C-15, C-18 | C-13, C-14, C-17 | change | Replace IP-05 with IP-04. "confidence matches how often it is right" is calibration, which Q-IP-13 already maps to IP-04 ("Calibration analysis"); one area for one practice. Neither area has a calibration control. No calibration control exists; see the gaps list. | low |
| Q-IP-09 | in-processing | Have you chosen the simplest model that performs well enough? | IP-03 | IP-03, PP-01 | C-17, C-18, C-19 | C-17, C-18, C-01, C-02, C-20 | change | Add PP-01. "the simplest model that performs well enough" is IP-03 (interpretable models) and the same trade-off as C-01 (alternatives analysis); PP-01 brings C-01. | medium |
| Q-IP-10 | in-processing | Have you recorded everything needed to train the same model again: settings (hyperparameters), random seeds, code and software versions? | IP-06 | IP-06 | C-17, C-18, C-19 | C-17, C-19, C-28 | keep | "recorded everything needed to train the same model again" is IP-06's definition. Under the IP-06 row it suggests C-17, C-19 and C-28 instead of C-17, C-18 and C-19. | medium |
| Q-IP-11 | in-processing | Have you checked that records are not lost or changed as your data is moved and processed? | IP-07 | IP-07 | C-03, C-09, C-10 | C-03, C-09 | keep | "records are not lost or changed as your data is moved" is IP-07 (data integrity). Under the IP-07 row, anonymisation (C-10) drops out. | medium |
| Q-IP-12 | in-processing | Have you created or updated a model card for this model? | IP-06, PO-07 | PO-07, IP-06 | C-17, C-18, C-19, C-26, C-28 | C-17, C-19, C-28 | change | Same areas, new order. "created or updated a model card" is documentation (PO-07 lists model cards first), so PO-07 should head the report; C-17 is reached either way. | medium |
| Q-IP-13 | in-processing | Which additional evaluation methods have you applied? | options: IP-04, IP-05, IP-01, IP-02 | options: IP-04, IP-05, IP-01, IP-02 | C-13, C-17, C-18, C-15, C-14, C-16 | C-13, C-14, C-17, C-21, C-15, C-16 | keep | A checklist: its areas come from the options (see the option table). `gaps` stays empty. | high |
| Q-IP-14 | in-processing | Have you considered whether aggregating data across populations masks important subgroup differences? | IP-02 | IP-02 | C-13, C-14, C-16 | same | keep | "aggregating data across populations masks … subgroup differences" is IP-02's definition. | high |
| Q-IP-15 | in-processing | When you tuned the model's settings (for example the decision threshold), did you check that results did not get worse for some groups? | IP-01, IP-04 | IP-01, IP-04 | C-13, C-14, C-15, C-17, C-18 | C-13, C-14, C-15, C-17 | keep | "tuned … results did not get worse for some groups" is IP-01 (different outcomes for groups) and IP-04 (the measure optimised). | high |
| Q-IP-19 | in-processing | Have you assessed whether the model's errors have differential impact across demographic groups? | IP-01, IP-02 | IP-01, IP-02 | C-13, C-14, C-15, C-16 | same | keep | "errors have differential impact across demographic groups" is IP-01 and IP-02. | high |
| Q-IP-20 | in-processing | Have you documented the model's known limitations, failure modes, and conditions under which it should not be used? | IP-03, PO-07 | PO-07, IP-03 | C-17, C-18, C-19, C-26, C-28 | C-17, C-19, C-28, C-18 | change | Same areas, new order. "documented the model's known limitations" is documentation (PO-07; C-17 covers "where it fails"), so PO-07 should head the report. | medium |
| Q-IP-21 | in-processing | Have you used version control for your code, data processing and trained models? | IP-06 | IP-06 | C-17, C-18, C-19 | C-17, C-19, C-28 | keep | Keep IP-06: "version control for your code, data processing and trained models" is IP-06's first named mitigation ("code versioning"). The fault is IP-06's control list, fixed in the IP-06 row: C-18 (explainability) goes, C-28 comes in. Still only a partial fit after the fix: no control is version control; see the gaps list. | medium |
| Q-IP-22 | in-processing | Have you checked whether someone could trick or manipulate the model? | IP-05, IP-07 | IP-05, IP-07 | C-13, C-15, C-18, C-03, C-09, C-10 | C-14, C-21, C-03, C-09 | keep | "trick or manipulate the model" is robustness (IP-05) and unauthorised modification (IP-07). Neither area has a security or adversarial-testing control. No control fits; see the gaps list. The experts may prefer no suggestion here to a partial one. | low |
| Q-IP-24 | in-processing | Have you tested the model on data from a later time than its training data? | IP-05, PO-01 | IP-05, PO-01 | C-13, C-15, C-18, C-21, C-22, C-23 | C-14, C-21, C-22, C-23 | keep | "data from a later time than its training data" is IP-05 (distribution shift) and PO-01 (drift). | medium |
| Q-PO-01 | post-processing | Do you regularly check, once the system is in use, whether its performance or its input data have changed? | PO-01 | PO-01 | C-21, C-22, C-23 | same | keep | "check … whether its performance or its input data have changed" is PO-01 and C-21. | high |
| Q-PO-02 | post-processing | Have you defined triggers and procedures for model retraining? | PO-01 | PO-01 | C-21, C-22, C-23 | same | keep | "triggers and procedures for model retraining" is C-22 under PO-01. | high |
| Q-PO-03 | post-processing | Can a person review and overrule the system's outputs before they are acted on? | PO-02 | PO-02 | C-21, C-24, C-25 | same | keep | "a person review and overrule the system's outputs" is C-24 under PO-02. | high |
| Q-PO-04 | post-processing | Have you defined clear roles and responsibilities for AI system outcomes (accountability matrix)? | PO-03 | PO-03 | C-21, C-25, C-26 | C-25, C-26 | keep | "roles and responsibilities … (accountability matrix)" is C-26 under PO-03. | high |
| Q-PO-05 | post-processing | Have you created an incident response plan for when the AI system produces harmful outputs? | PO-02, PO-03 | PO-03, PO-02 | C-21, C-24, C-25, C-26 | C-25, C-26, C-21, C-24 | change | Same areas, new order. "incident response plan" is named in PO-03's `mitigated` text, so PO-03 should head the report; PO-02 adds C-24 (shut the system down). | medium |
| Q-PO-06 | post-processing | Have you provided training or educational resources for end-users of the AI system? | PO-04 | PO-04 | C-24, C-25, C-27 | same | keep | "training or educational resources for end-users" is C-27 under PO-04. | high |
| Q-PO-07 | post-processing | Can end-users understand the AI system's outputs, confidence levels, and limitations? | PO-04, PO-02 | PO-04, PO-02 | C-24, C-25, C-27, C-21 | same | keep | "end-users understand the AI system's outputs, confidence levels, and limitations" is PO-04 (user literacy), with PO-02 for acting on low confidence. | medium |
| Q-PO-16 | post-processing | Have you introduced the system in stages, for example at one site first, before using it everywhere? | PO-01 | PO-01 | C-21, C-22, C-23 | same | keep | "introduced the system in stages" is C-23 (canary deployment) under PO-01. | high |
| Q-PO-17 | post-processing | Once the system is in use, do you check results for each group as well as overall accuracy? | PO-01, PO-06 | PO-01, IP-01 | C-21, C-22, C-23, C-24, C-25, C-27 | C-21, C-22, C-23, C-13, C-14, C-15 | change | Swap PO-06 for IP-01. "check results for each group as well as overall" is subgroup monitoring (C-13, C-14 under IP-01). Feedback loop absence (PO-06) is about people reporting problems, which this question does not ask. | medium |
| Q-PO-18 | post-processing | Have you defined performance thresholds below which the system should be automatically disabled or flagged? | PO-01, PO-02 | PO-01, PO-02 | C-21, C-22, C-23, C-24, C-25 | same | keep | "thresholds below which the system should be … disabled or flagged" is PO-01 (monitoring) and PO-02 (C-24: shut down). | high |
| Q-PO-08 | post-processing | Have you established feedback channels for affected communities and end-users? | PO-06 | PO-06 | C-24, C-25, C-27 | C-24, C-25, C-20 | keep | "feedback channels for affected communities" is PO-06's definition and C-25. | high |
| Q-PO-09 | post-processing | Is there a mechanism for individuals affected by AI decisions to contest or appeal those decisions? | PO-06 | PO-06 | C-24, C-25, C-27 | C-24, C-25, C-20 | keep | "contest or appeal those decisions" is C-25 under PO-06. | high |
| Q-PO-10 | post-processing | Have you created complete documentation for the deployed system (codebook, deployment specs)? | PO-07 | PO-07 | C-17, C-19, C-26, C-28 | C-17, C-19, C-28 | keep | "documentation for the deployed system (codebook, deployment specs)" is C-28 under PO-07. | high |
| Q-PO-11 | post-processing | Which of the following governance measures are in place? | options: PO-03, PO-07, IP-06, PP-06, PO-06 | options: PP-06, PO-03, IP-07, IP-06, PO-07, PO-06 | C-21, C-25, C-26, C-17, C-19, C-28, C-18, C-09, C-10, C-11, C-24, C-27 | C-09, C-10, C-11, C-25, C-26, C-03, C-17, C-19, C-28, C-24, C-20 | change | A checklist: its areas come from the options (see the option table). `gaps` stays empty. | high |
| Q-PO-12 | post-processing | Have you assessed the AI system's performance across the deployment context's diversity (geographic, linguistic, cultural)? | PO-01 | IP-02, PO-01 | C-21, C-22, C-23 | C-13, C-14, C-16, C-21, C-22, C-23 | change | Add IP-02 and lead with it. "performance across the deployment context's diversity (geographic, linguistic, cultural)" is results broken down by group (IP-02: works on average but fails for specific populations; C-14, C-16). PO-01 stays for checking in use. | medium |
| Q-PO-13 | post-processing | Have you planned when and how the AI system will be retired or replaced? | PO-05 | PO-03, PO-05 | C-02, C-26 | C-25, C-26, C-02, C-01 | change | Add PO-03 and lead with it. "planned when and how the AI system will be retired" is mainly a decision about who decides and how users and data are handled (PO-03, C-26). PO-05 stays second because the question's good practice counts "the computing and energy the system uses while running". No control is about retiring a system. C-09 (data "eventually retired") is the nearest, and this proposal does not reach it. Under it the report lists C-25 (redress) first, which does not fit a retirement plan; the experts may prefer PO-05 first, or adding IP-07 or PP-06 for C-09. | medium |
| Q-PO-14 | post-processing | Does the system handle unusual inputs safely, for example by flagging them for a person instead of giving a confident answer? | PO-02, PO-01, PO-03 | PO-02, PO-01 | C-21, C-24, C-25, C-22, C-23, C-26 | C-21, C-24, C-25, C-22, C-23 | change | Drop PO-03. "handle unusual inputs safely … flagging them for a person" is PO-02 (C-24) and PO-01 (detecting inputs unlike training data). PO-03 came from the 5.0.0 merge rule (SITTING-1.md:422), not from the question. | medium |
| Q-PO-15 | post-processing | Have you communicated the AI system's limitations and intended use to all stakeholders? | PO-04, PO-07 | PO-04, PO-07 | C-24, C-25, C-27, C-17, C-19, C-26, C-28 | C-24, C-25, C-27, C-17, C-19, C-28 | keep | "communicated the AI system's limitations and intended use to all stakeholders" is PO-04 (understanding limitations) and PO-07 (documentation). | high |
| Q-PO-20 | post-processing | Have you involved representatives of affected communities in the design and evaluation of the AI system? | PO-06, PO-02 | PO-06 | C-24, C-25, C-27, C-21 | C-24, C-25, C-20 | change | Drop PO-02. "involved representatives of affected communities in the design and evaluation" is PO-06's "community engagement", which under the PO-06 row brings C-20. Human oversight of outputs (PO-02) is not asked. | medium |
| Q-PO-21 | post-processing | Have you assessed the AI system's impact on existing workflows and professional practices? | PO-02, PO-04 | PO-02, PO-04 | C-21, C-24, C-25, C-27 | same | keep | "impact on existing workflows and professional practices" is PO-02 (how people review outputs in their work) and PO-04 (what users understand). | medium |
| Q-PO-22 | post-processing | Have you ensured compliance with applicable data protection regulations and ethical guidelines? | PO-03 | PP-06, PO-03 | C-21, C-25, C-26 | C-09, C-10, C-11, C-25, C-26 | change | Add PP-06 and lead with it. "compliance with applicable data protection regulations" is PP-06, whose `mitigated` text ends "compliance with national data protection laws" (C-09, C-10, C-11). PO-03 stays for "ethical guidelines" approvals; under the PO-03 row, drift (C-21) drops out. | high |
| Q-PO-23 | post-processing | Have you established regular review cycles to reassess the AI system's appropriateness and performance? | PO-01, PO-03 | PO-01, PO-03 | C-21, C-22, C-23, C-25, C-26 | same | keep | "regular review cycles to reassess … appropriateness and performance" is PO-01 (performance) and PO-03 (who decides). | medium |
| Q-PO-24 | post-processing | Have you considered the AI system's impact on equity of access to services? | PO-04 | PO-04, PP-04 | C-24, C-25, C-27 | C-24, C-25, C-27, C-03, C-05, C-07 | change | Add PP-04. "impact on equity of access to services" is about who the system serves (PP-04: C-07 maps who is helped or harmed), as well as user literacy (PO-04). Unsure: equity of access has no exact area; the experts may prefer IP-01. | low |

## Checklist options

The five questions with an `optionGapMap`: Q-PP-16, Q-PP-17, Q-IP-06, Q-IP-13, Q-PO-11. A ticked option counts as in place; the areas of the unticked options are suggested first. Q-IP-06 also has `gaps: ["IP-01"]`, which always shows.

| Question | Option | Areas now (role) | Proposed | Why | Confidence |
|---|---|---|---|---|---|
| Q-PP-16 | Missing data analysis | PP-02 (primary) | same | Missing data is PP-02 (data too sparse). | high |
| Q-PP-16 | Outlier detection | IP-07 (supporting) | same | Outliers are a quality and integrity check (IP-07). | medium |
| Q-PP-16 | Duplicate detection | IP-07 (supporting) | same | Duplicates are a data integrity check (IP-07). | high |
| Q-PP-16 | Class imbalance analysis | PP-02 (supporting), PP-05 (supporting) | same | Imbalance is scarcity of some classes (PP-02) and uneven sampling (PP-05). | high |
| Q-PP-16 | Correlation matrix analysis | PP-03 (supplementary) | same | Correlations reveal proxies for sensitive attributes, as Q-PP-11 does under PP-03. | low |
| Q-PP-16 | Distribution analysis across subgroups | PP-04 (primary), PP-05 (supporting) | same | Subgroup distribution is PP-04 and PP-05, with C-05. | high |
| Q-PP-16 | Data lineage/provenance tracking | PO-07 (primary) | same | Provenance is documentation (PO-07, C-19). | medium |
| Q-PP-16 | Temporal consistency checks | IP-07 (supporting) | same | Consistency over time is an integrity check (IP-07). PO-01 (drift) would also fit. | low |
| Q-PP-17 | Historical bias | PP-03 (primary) | same | PP-03's definition. | high |
| Q-PP-17 | Population bias | PP-04 (primary) | same | PP-04's definition. | high |
| Q-PP-17 | Sampling/generalization bias | PP-05 (primary) | same | PP-05's definition. | high |
| Q-PP-17 | Labeling bias | PP-07 (primary) | same | PP-07's definition. | high |
| Q-PP-17 | Survey bias | PP-05 (supplementary) | same | How respondents were reached is sampling (PP-05). | medium |
| Q-PP-17 | Survivorship bias | PP-02 (supporting) | PP-05 (supporting) | Move PP-02 to PP-05. Survivorship bias is data that only holds the cases that came through a filter, which is non-random sampling (PP-05), not data that is too sparse (PP-02). | medium |
| Q-PP-17 | Measurement bias | PP-02 (supporting) | same | Unsure. PP-02 (data "not relevant to the problem") is a loose fit; C-04 ("what got measured") sits under PP-02, PP-03 and PP-07, so any of them reaches it. | low |
| Q-PP-17 | Exclusion bias | PP-04 (supporting) | same | Groups left out of the data is PP-04. | high |
| Q-IP-06 | Statistical Parity | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Conditional Statistical Parity | IP-01 (supporting), IP-02 (primary) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Predictive Parity | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | False Positive Error Rate Balance | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | False Negative Error Rate Balance | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Overall Accuracy Equality | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Treatment Equality | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Conditional Use Accuracy Equality | IP-01 (supporting), IP-02 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-06 | Test Fairness / Well-Calibration | IP-01 (supporting) | same | A fairness metric is IP-01 (C-13). The two conditional metrics compare like with like within strata, so they add IP-02. | high |
| Q-IP-13 | Cross-validation (k-fold) | IP-04 (primary) | same | Unsure. Stable estimates fit IP-04 (metric choice) loosely; IP-05's `mitigated` text names "cross-validation across diverse conditions". | low |
| Q-IP-13 | Bootstrapping | IP-04 (supporting) | same | Same reading as cross-validation: an estimate's stability, kept with IP-04. | low |
| Q-IP-13 | Nested cross-validation | IP-04 (supplementary) | same | Same reading as cross-validation. | low |
| Q-IP-13 | Learning curves analysis | IP-05 (primary) | same | Unsure. A learning curve shows whether more data would help, which is closer to PP-02 than to IP-05. | low |
| Q-IP-13 | Calibration analysis | IP-04 (supporting) | same | Calibration is IP-04 here; Q-IP-18 is proposed to match. | medium |
| Q-IP-13 | Error analysis by subgroup | IP-01 (supporting), IP-02 (primary) | same | IP-02 (C-14) and IP-01. | high |
| Q-IP-13 | Sensitivity/perturbation analysis | IP-05 (primary) | same | IP-05's `mitigated` text names "sensitivity analysis". | high |
| Q-IP-13 | AUC-ROC curve analysis | IP-04 (supporting) | same | A metric choice (IP-04). | medium |
| Q-PO-11 | Data governance committee | PO-03 (primary) | PP-06 (primary), PO-03 (supporting) | Add PP-06 and lead with it. Data governance is C-09, which only PP-06 and IP-07 reach; PO-03 stays for the committee's ownership role. | medium |
| Q-PO-11 | Ethics review board/process | PO-03 (primary) | same | Ethics review is an accountability structure (PO-03). | medium |
| Q-PO-11 | Audit trail/logging | PO-03 (supporting), PO-07 (primary) | IP-07 (primary), PO-03 (supporting) | Swap PO-07 for IP-07. IP-07's `mitigated` text names "audit logging"; documentation deficit (PO-07) is about model cards and datasheets. | low |
| Q-PO-11 | Version control for models and data | IP-06 (primary), PO-07 (supporting) | same | IP-06's "code versioning". | high |
| Q-PO-11 | Access control policies | PP-06 (primary) | same | PP-06's "access controls". | high |
| Q-PO-11 | Compliance with national data protection laws | PP-06 (primary) | same | PP-06's "compliance with national data protection laws". | high |
| Q-PO-11 | Regular third-party audits | PO-03 (supporting) | same | Outside audit is accountability (PO-03). | medium |
| Q-PO-11 | Community advisory board | PO-06 (primary) | same | PO-06's "community engagement"; under the PO-06 row it brings C-20. | high |

## What no control covers

These practices are asked about, or named in an area's own text, but none of the 28 controls is about them. Mapping cannot fix this. Adding a control changes the count of 28 that the content check requires (`lib/content/validate.ts:32`, FR-CNT-01), so each one is a decision for the owner as well as the experts.

| Practice | Where it is asked | Note |
|---|---|---|
| Version control and experiment tracking | Q-IP-21, Q-IP-10, IP-06; Q-PO-11 option "Version control for models and data" | IP-06's own `mitigated` text names it first. |
| Robustness and stress testing | Q-IP-08, Q-IP-17, Q-IP-24, IP-05 | IP-05's `mitigated` text names robustness testing and sensitivity analysis. |
| Security and adversarial testing | Q-IP-22 | Q-IP-22's good practice names the Adversarial Robustness Toolbox. |
| Calibration | Q-IP-18; Q-IP-13 option "Calibration analysis" |  |
| Measuring error types | Q-IP-03 |  |
| Problem statement and success criteria | Q-PP-02 |  |
| Impact assessment (rights) | Q-PP-05 | C-02 carries the EU AI Act Art. 27 link but is reached only through PP-01 and PO-05. |
| Incident response plan | Q-PO-05, PO-03 | PO-03's `mitigated` text names it. |
| Retiring a system | Q-PO-13 |  |
| Data-validation pipeline and audit log | Q-IP-11, IP-07 | IP-07's `mitigated` text names both. |

## A line for the content approver to check

This line now sits at the top of the project page and on Home for someone with no project yet (design G5; `lib/project/copy.ts:121`). The wording is the designer's call, and the design asks for it to be checked with the content approver:

> Answer the questions that apply. At any point you can open a working report: next steps by risk area, plus draft data card, model card and mitigation plan. About 5 minutes a question.

"About 5 minutes a question" is the pilot's upper bound (audit §9). Reply `G5: accept`, `G5: edit <your wording>` or `G5: decline`.

## Release notes for 5.2.0

Carry these into the release that ships this mapping. None of them is done here.

1. **`projectConfig.json`** gains `stageApplicability`, the G7 table, which the owner approved on 19 November ("With 5.2.0 (Recommended)"):
   ```json
   "stageApplicability": {
     "concept": ["pre-processing"],
     "development": ["pre-processing", "in-processing"],
     "testing": ["pre-processing", "in-processing", "post-processing"],
     "deployed": ["pre-processing", "in-processing", "post-processing"],
     "retired": ["pre-processing", "in-processing", "post-processing"]
   }
   ```
   It gains `"controlSuggestionsApproved": true` only after the experts' `risk-mapping` record is in `data/content/5.2.0/signoffs.json`. With the switch on, the content check requires that record as well as the seven usual ones (`lib/content/validate.ts:597-598`).
2. **`questionBank.json` and `assessmentAreas.json`** take `meta.version: "5.2.0"`, which the content check requires (`lib/content/validate.ts:366`).
3. **The ten notebooks** in `notebooks/technical/*.ipynb` are regenerated with `npx tsx notebooks/tools/write-linked-content.ts`. If C-10's new name is accepted, check that its notebook (`C-10_privacy-anonymization.ipynb`) picks it up.
4. **The registry migration** comes from `scripts/content/release-version.ts`.
5. **The revision test** is modelled on `__tests__/content/revision-5.1.0.test.ts`.
6. **Saved answers.** Every answer saved against 5.1.0 will read as differing once 5.2.0 runs, because the comparison includes the content version (`components/decision/DecisionForm.tsx:150-155`).
7. **The pair check has to change first.** For each question, the content check compares its (risk area, control) pairs with the pairs of the 4.0.0 question it came from, and fails on any difference (QC-02, `lib/content/validate.ts:494-500`). A run on a scratch copy of 5.1.0 with this proposal's mapping applied (`validateContentVersion`, baseline `data`, the 5.1.0 question-set proposal) gave 40 problems, all of them QC-02 lines, starting with Q-PP-24 and Q-PP-07; the unchanged 5.1.0 gives none. The 5.0.0 sitting met the same rule and deferred mapping changes because of it (`docs/content/question-set-5.0.0/SITTING-1.md:422-424`). 5.2.0 needs the rule amended, for example to compare against the signed `risk-mapping` record instead. QC-02 is a requirement, so the amendment is the owner's decision.
8. **A question-set proposal for 5.2.0.** The content tests look for `docs/content/question-set-<version>/proposal.json` (`__tests__/unit/content-bundle.test.ts:32`, `__tests__/unit/content-release.test.ts:229`). Without one, a version is checked as the 4.0.0 set kept whole (`validate.ts:443-447`), which 5.1.0's cuts and merges already break: run without its proposal, 5.1.0 gives 47 problems, starting with "question Q-PP-24: not a 4.0.0 question, and no approved proposal adds it". 5.2.0 needs that file, carrying 5.1.0's approved actions, or a change to the check. This pack's `proposal.json` is in `mapping-5.2.0/` and none of those tests reads it.
9. **What the signature covers** (deferred, controller's ruling). The area names that the control card shows under "Also helps with" are not in the `risk-mapping` record. The experts and the 5.2.0 release should decide whether the record signs area names too. The same question applies to the area's stage ("Usually applied in"), the notebook and template links, and the checklist `role` (found while drafting this pack).
10. **A new control** for any practice under "What no control covers" changes the count of 28 that the content check requires (`validate.ts:32`), and needs its own text approved.
11. **Earlier deferrals this pack settles if accepted:** CG-19 (Q-PP-24 → PP-01 for C-20), and the areas that Q-IP-08 and Q-PO-14 took on only through the 5.0.0 merge rule (`SITTING-1.md:422-424`).

## How this was made, and the check

The current mapping was read from 5.1.0 with these commands, run in the repository root:

```sh
# 67 questions: id, type, gaps, optionGapMap
jq -c '[.stages[].modules[].questions[] | {id, type, gaps, optionGapMap}]' data/content/5.1.0/questionBank.json
# 62 with a non-empty gaps; 5 with an optionGapMap
jq '[.stages[].modules[].questions[] | select((.gaps|length) > 0)] | length' data/content/5.1.0/questionBank.json
jq -r '[.stages[].modules[].questions[] | select(has("optionGapMap")) | .id] | join(", ")' data/content/5.1.0/questionBank.json
# 21 areas with their controls; 28 controls with the text people see
jq -c '[.areas[] | {id, name, controls}]' data/content/5.1.0/assessmentAreas.json
jq -c '[.controls[] | {id, name, type, description, resources: [.resources[] | {title, url, type}]}]' data/content/5.1.0/assessmentAreas.json
```

`proposal.json`, next to this file, holds every row keyed by id: for each question its areas now and proposed, the option maps for the checklists, and the controls shown before and after; for each area its controls now and proposed; for each control the text shown; and the list of practices no control covers. Each row has `status: "proposed"`, a reason and a confidence. The tables here are generated from it and from the 5.1.0 files, so ids, question text and control text match the content exactly.

The check below proves that each of the 67 question ids and each of the 21 area ids appears exactly once, both in `proposal.json` and as the first cell of a row in the "Questions" and "Risk areas and their controls" tables. It also checks what the content check would check on the proposed mapping. It prints the counts and ends with `67 21`.

```sh
python3 - <<'PY'
import json, re
bank = json.load(open('data/content/5.1.0/questionBank.json'))
af = json.load(open('data/content/5.1.0/assessmentAreas.json'))
p = json.load(open('docs/content/mapping-5.2.0/proposal.json'))
md = open('docs/content/mapping-5.2.0/REVIEW.md').read()
qs = [q for s in bank['stages'].values() for m in s['modules'] for q in m['questions']]
qids, aids, cids = [q['id'] for q in qs], [a['id'] for a in af['areas']], [c['id'] for c in af['controls']]
def rows(title, pat):
    body = md.split('\n## ' + title + '\n', 1)[1].split('\n## ', 1)[0]
    cells = [l.split('|')[1].strip() for l in body.splitlines() if l.startswith('| ')]
    return [c for c in cells if re.fullmatch(pat, c)]
seen = {'question rows': (rows('Questions', r'Q-[A-Z]+-[A-Z0-9-]+'), qids),
        'area rows': (rows('Risk areas and their controls', r'(PP|IP|PO)-0[1-7]'), aids),
        'proposal questions': (list(p['questions']), qids), 'proposal areas': (list(p['areas']), aids),
        'proposal controls': (list(p['controls']), cids)}
for name, (got, want) in seen.items():
    assert len(got) == len(set(got)) and set(got) == set(want), name
    print(f'{name}: {len(got)} ids, each exactly once')
print('5.1.0: questions', len(qs), '| non-empty gaps', sum(1 for q in qs if q['gaps']),
      '| optionGapMap', [q['id'] for q in qs if 'optionGapMap' in q], '| areas', len(aids), '| controls', len(cids))
def areas_of(r):
    m = (r.get('optionGapMap') or {}).get('proposed') or {}
    return set(r['gaps']['proposed']) | {e['area'] if isinstance(e, dict) else e for es in m.values() for e in es}
mapped = set().union(*(areas_of(r) for r in p['questions'].values()))
reached = {c for a in p['areas'].values() for c in a['controls']['proposed']}
assert mapped == set(aids) and reached == set(cids)
assert all(r['status'] == 'proposed' for part in ('questions', 'areas', 'controls') for r in p[part].values())
assert p['questions']['Q-PP-GATE-SENSITIVE']['gaps']['proposed'] == []
for qid, r in p['questions'].items():
    if 'optionGapMap' in r: assert list(r['optionGapMap']['proposed']) == list(r['optionGapMap']['now']), qid
print('proposed mapping: areas reached', len(mapped), '| controls reached', len(reached), '| gate maps to none')
ch = lambda part: sum(1 for r in p[part].values() if r['change'] == 'change')
opts = [(q, o) for q, r in p['questions'].items() if 'optionGapMap' in r for o in r['optionGapMap']['now']]
och = sum(1 for q, o in opts if p['questions'][q]['optionGapMap']['now'][o] != p['questions'][q]['optionGapMap']['proposed'][o])
print('proposed change / keep: questions', ch('questions'), '/', 67 - ch('questions'), '| areas', ch('areas'), '/', 21 - ch('areas'),
      '| options', och, '/', len(opts) - och, '| control text', ch('controls'), '/', 28 - ch('controls'))
print(len(set(rows('Questions', r'Q-[A-Z]+-[A-Z0-9-]+'))), len(set(rows('Risk areas and their controls', r'(PP|IP|PO)-0[1-7]'))))
PY
```

## How sure the draft is

- Each row was judged against the question's text and good practice text, the area's description and `mitigated` text, and the control's description, all as they stand in 5.1.0. Nothing outside the repository was consulted, and no control link was opened. The audit sample (`B-content.md` §4) covered 22 questions; the other 45 questions, all 21 area lists and all 41 checklist options are this draft's own judgment.
- The high rows are the most certain. In those, the question or area text names the control's practice almost word for word (Q-PP-01 → C-01, Q-PO-10 → C-28, PO-07 → C-17, C-19 and C-28). Also Q-PO-22 → PP-06, where PP-06's text names the same law. If an expert finds one of these wrong, the draft's reading of an area definition is wrong, and every row that relies on that reading should be checked again.
- The low rows are the least certain: IP-05, Q-PP-05, Q-IP-01, Q-IP-02, Q-IP-18, Q-IP-22 and Q-PO-24, and the cross-validation, learning-curve and measurement-bias options. In these the 28 controls offer only partial fits, or two areas fit about equally well. For IP-05 and Q-IP-22 the honest choice may be to suggest nothing until a fitting control exists.
- Mapping cannot settle the ten practices under "What no control covers". They need new controls, and so a change to the count of 28.
- 5 rows (Q-PP-09, Q-PP-18, Q-IP-12, Q-IP-20, Q-PO-05) only reorder areas so the best-fitting one heads the report. That is a judgment about the report's grouping, separate from whether the areas are right.
