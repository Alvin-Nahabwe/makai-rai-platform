# Sitting: the ten technical notebooks

For the product owner. Prepared by C-NB on branch `unit/c-nb-2`, cut from release 0.6.0 at `46e49ddb`. Nothing here has been approved. Your pass is tied to the exact files whose hashes are at the end. The Notebooks workflow passed on that commit: https://github.com/Alvin-Nahabwe/makai-rai-platform/actions/runs/42226926754

## How to answer

- One line per notebook: **"C-xx: pass"**, **"C-xx: fail"**, or **"C-xx: pass with edits <what>"**. An edit changes the file and its hash, and you then pass the new hash.
- Reviewer: by default **Product owner, MAK-AI**. C-10 needs a privacy-competent reviewer: please name who.
- A notebook you do not review stays unreleased. It is recorded as a row whose trigger is "its review passes" (SRS line 4808). At least two reviewed notebooks are needed to ship; by default C-13 and C-14.
- Answer the questions below too. "Questions as proposed" is enough if you accept the defaults.

## Order

C-13, C-14, C-21, C-18, C-03, C-04, C-15, C-05, C-16 (SRS line 4800). Then C-10 on its own, as the privacy review. C-13 and C-14 come first because the reviewer also checked every metric in them against the library's own definition.

## What you have for each notebook

Each notebook has the source file, the executed copy as a web page (open it in a browser), the two run logs, the evidence summary the notebook wrote, the technical review by an independent reviewer who wrote none of it, and a line on what changed after that review. The runs used two CPU cores and no GPU. The limit (NB-AC-02) is 10 minutes and 4 GB. Every run below finished without error, and the evidence check passed.

Web pages, logs and evidence are outside the repository, in `/home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/<C>/`.

### C-13 Subgroup Fairness Metrics

| | |
|---|---|
| Data | UCI Adult (1994 US census extract) |
| Source | `notebooks/technical/C-13_subgroup-fairness.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-13_subgroup-fairness.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-13/C-13_subgroup-fairness.html` |
| Clean run | 1:21.24, 268,224 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-13/run1.log`) |
| Offline run (no network, from the cached data) | 1:10.07, 268,104 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-13/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-13/evidence/C-13_summary.md` |
| Technical review | `docs/content/notebooks-review/C-13.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-13.md` |
| Changed after the review | The statement that the fairness numbers cannot all be zero together was wrong and is now correct. Step 5 now says each gap is highest minus lowest, so it is never below zero. The Brier score is no longer presented as a calibration measure. Stop-and-decide question 3 is now balanced. A boosted-model option (PRACTICE_MODEL) was added. A paragraph on how to choose groups that matter locally was added. |
| Source SHA-256 | `a7aa2b5456ff9f994a3ecc4ddb98be23136e086d01e1116e507f44799c31c98b` |
| Notebooks CI | run 42226926754: passed |

### C-14 Disaggregated Performance Analysis

| | |
|---|---|
| Data | UCI Diabetes 130-US Hospitals |
| Source | `notebooks/technical/C-14_disaggregated-performance.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-14_disaggregated-performance.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-14/C-14_disaggregated-performance.html` |
| Clean run | 0:48.27, 402,772 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-14/run1.log`) |
| Offline run (no network, from the cached data) | 0:47.14, 402,624 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-14/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-14/evidence/C-14_summary.md` |
| Technical review | `docs/content/notebooks-review/C-14.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-14.md` |
| Changed after the review | The per-group flagged share, size and false positive rate now really come from Fairlearn MetricFrame, as the text said. The Simpson check now ignores groups with too few cases. The text on groups below overall now says that with 30 groups, one or two can fall outside by chance. Flagged share is now explained. The caveat now says the data has real missing values. A question on false alarms was added. |
| Source SHA-256 | `6c28b2673aca6a44ed70d22d300896a41ed7fd62c8b29dc20a414a684ecf48ea` |
| Notebooks CI | run 42226926754: passed |

### C-21 Monitoring and Drift Detection

| | |
|---|---|
| Data | UCI Bike Sharing |
| Source | `notebooks/technical/C-21_monitoring-drift.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-21_monitoring-drift.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-21/C-21_monitoring-drift.html` |
| Clean run | 0:04.74, 233,620 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-21/run1.log`) |
| Offline run (no network, from the cached data) | 0:04.69, 233,076 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-21/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-21/evidence/C-21_summary.md` |
| Technical review | `docs/content/notebooks-review/C-21.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-21.md` |
| Changed after the review | The explanation of PSI now covers category columns. A pointer to the next cell was fixed. The notebook now says its reference error is optimistic, so error ratios read a little high. Where to go next now names real resources. Demand roughly doubled became grew by about two-thirds. The when-to-use list is now faithful to the question texts. |
| Source SHA-256 | `c938055f5331d2395e7f0b144970d8a9d947de6704dcbe951ee55739fd4ea0cc` |
| Notebooks CI | run 42226926754: passed |

### C-18 Explainability Analysis

| | |
|---|---|
| Data | UCI Statlog German Credit |
| Source | `notebooks/technical/C-18_explainability-analysis.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-18_explainability-analysis.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-18/C-18_explainability-analysis.html` |
| Clean run | 0:15.03, 260,356 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-18/run1.log`) |
| Offline run (no network, from the cached data) | 0:14.21, 260,492 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-18/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-18/evidence/C-18_summary.md` |
| Technical review | `docs/content/notebooks-review/C-18.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-18.md` |
| Changed after the review | SHAP numbers are now said to add up to the gap from the average score, not to the score. The waterfall scale is explained. Partial dependence now says it covers the 5th to 95th percentile. The planted-leak step number was corrected. A DECISION_THRESHOLD line was added to the adapt cell. A limit on whole-number columns in the small-change test was added. The Step 9 sentence for a person now names the values of that person. Q-IP-22 and Q-IP-01 were added, with limits stated. |
| Source SHA-256 | `454452565c34b2a51db9d3a4a24bc6a1f87d8df91ad3a09f9260dc12e21b8fba` |
| Notebooks CI | run 42226926754: passed |

### C-03 Data Quality and Representativeness Audit

| | |
|---|---|
| Data | UCI Diabetes 130-US Hospitals and a stored World Bank reference |
| Source | `notebooks/technical/C-03_data-quality-audit.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-03_data-quality-audit.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-03/C-03_data-quality-audit.html` |
| Clean run | 0:06.27, 300,788 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-03/run1.log`) |
| Offline run (no network, from the cached data) | 0:05.59, 301,508 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-03/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-03/evidence/C-03_summary.md` |
| Technical review | `docs/content/notebooks-review/C-03.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-03.md` |
| Changed after the review | Wording now matches what the code runs for missing values, duplicates (four counts, two named as near duplicates) and outliers. A sixth stop-and-decide question asks the team to set the thresholds. A limit was added: it checks one file once, not a pipeline. The summary heading What was audited became What was checked. The question list was narrowed to what the notebook runs. |
| Source SHA-256 | `a478bc653ebb0afe7687683a9400453be53404620947199c65c3bc39c297bca1` |
| Notebooks CI | run 42226926754: passed |

### C-04 Bias Detection in Data

| | |
|---|---|
| Data | UCI Adult and a synthetic annotator table |
| Source | `notebooks/technical/C-04_bias-detection.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-04_bias-detection.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-04/C-04_bias-detection.html` |
| Clean run | 0:07.45, 284,628 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-04/run1.log`) |
| Offline run (no network, from the cached data) | 0:07.35, 284,472 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-04/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-04/evidence/C-04_summary.md` |
| Technical review | `docs/content/notebooks-review/C-04.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-04.md` |
| Changed after the review | The reason for using Cramer's V was corrected. The proxy test now says which columns it reads and that guessing gets 0.5 for two groups and 0.2 for five. The labelling step now explains its second table. Stop-and-decide asks the team to set two thresholds. The caveat now teaches how to choose groups that matter locally. |
| Source SHA-256 | `4b7423006c177a7426c7df7c86bb611ac483a5e081c915f53ac75f9c19f3341a` |
| Notebooks CI | run 42226926754: passed |

### C-15 Bias Mitigation Techniques

| | |
|---|---|
| Data | UCI Adult |
| Source | `notebooks/technical/C-15_bias-mitigation.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-15_bias-mitigation.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-15/C-15_bias-mitigation.html` |
| Clean run | 0:16.10, 315,584 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-15/run1.log`) |
| Offline run (no network, from the cached data) | 0:16.65, 315,012 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-15/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-15/evidence/C-15_summary.md` |
| Technical review | `docs/content/notebooks-review/C-15.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-15.md` |
| Changed after the review | The selection rate wording was fixed (the share the model predicts favourable). The description of the in-training method was corrected, and its tolerance is now called a target, not a guarantee. A limit was added: only one group column is mitigated at a time. Q-IP-15 was restored to the when-to-use list and the summary. A paragraph on choosing the group was added. |
| Source SHA-256 | `267249dce3a37818fb60e771913b1a700cd47d9244d5446384be94f31f36abbd` |
| Notebooks CI | run 42226926754: passed |

### C-05 Data Distribution Analysis

| | |
|---|---|
| Data | UCI Statlog German Credit |
| Source | `notebooks/technical/C-05_data-distribution.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-05_data-distribution.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-05/C-05_data-distribution.html` |
| Clean run | 0:04.03, 202,108 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-05/run1.log`) |
| Offline run (no network, from the cached data) | 0:04.09, 201,784 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-05/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-05/evidence/C-05_summary.md` |
| Technical review | `docs/content/notebooks-review/C-05.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-05.md` |
| Changed after the review | The intersections step now says empty combinations are not counted. The reference step now says people in groups you did not name are left out. The summary no longer calls the default group size accepted, and the comments say 30 and 20 are examples. One word (score) was replaced. |
| Source SHA-256 | `8bd325cce56c08ccfde3cb5da20f932042f40fb7ef79356bcbbb3621241a3e48` |
| Notebooks CI | run 42226926754: passed |

### C-16 Stratified Model Evaluation

| | |
|---|---|
| Data | MasakhaNEWS (four languages) |
| Source | `notebooks/technical/C-16_stratified-evaluation.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-16_stratified-evaluation.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-16/C-16_stratified-evaluation.html` |
| Clean run | 0:46.48, 397,016 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-16/run1.log`) |
| Offline run (no network, from the cached data) | 0:47.39, 400,516 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-16/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-16/evidence/C-16_summary.md` |
| Technical review | `docs/content/notebooks-review/C-16.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-16.md` |
| Changed after the review | The decision table now reads the paired difference between the two designs, not two overlapping ranges. The leakage step now says that without shared keys the two scores differ only by chance. A limit was added: macro F1 is not comparable across languages. The data statement now says seven topic labels, not five. |
| Source SHA-256 | `9827ce699cc329e9c223d51f064f295503b98d09e07adf2e309db08f1ee9367c` |
| Notebooks CI | run 42226926754: passed |

### C-10 Privacy and Anonymization Protocols

| | |
|---|---|
| Data | UCI Adult and synthetic names and phone numbers |
| Source | `notebooks/technical/C-10_privacy-anonymization.ipynb`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/notebooks/technical/C-10_privacy-anonymization.ipynb` |
| Executed copy (web page) | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-10/C-10_privacy-anonymization.html` |
| Clean run | 0:05.06, 192,576 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-10/run1.log`) |
| Offline run (no network, from the cached data) | 0:05.22, 192,940 kB (log: `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-10/run2.log`) |
| Evidence summary it wrote | `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-reports/notebooks-html/C-10/evidence/C-10_summary.md` |
| Technical review | `docs/content/notebooks-review/C-10.md`, `file:///home/alvin/Downloads/MAK_RAI/.worktrees/v060-C-NB/docs/content/notebooks-review/C-10.md` |
| Changed after the review | Adult's income column had four values (the test rows end in a full stop), so l-diversity was overstated. This is fixed. The residual-risk sentence was repaired. A limit was added: l = 2 can still give the value away. Q-IP-11 was restored with narrow wording, and the word appropriate was restored in Q-PP-14. |
| Source SHA-256 | `46df30a6b7c5506491967a3944878ce1626592be852fc9121936e9d2be0d8159` |
| Notebooks CI | run 42226926754: passed |

## Questions for you

**Q1. C-16 item 8: the Q-PO-12 paragraph in the when-to-use cell.** The cell says a team may also attach the summary to Q-PO-12 (performance across languages after deployment), "although the framework does not link that question to this control". The reviewer asked for the paragraph to be deleted, because the evidence summary already carries the same point. The author kept it, because it is true and useful to a team. At the time, a test would have failed if it was deleted. That is no longer so: deleting it now passes all tests, and the evidence summary line says "which the framework does not link" on its own line. Nothing in the tests decides this. See `docs/content/notebooks-review/C-16.md`, item 8.
- Proposed: **keep the paragraph.** It tells the team plainly why Q-PO-12 is not in the linked list.

**Q2. C-13: a deviation from the Task 15 review.** The review asked for a new line in the adapt cell with a comment that names the two choices in quotation marks. The comment had to lose its quotation marks ("logistic, or boosted (gradient-boosted trees)"), because the notebook lint reads a quoted word in that cell as a column name and then finds "boosted" in the model cell. The default and every result are unchanged.
- Proposed: **accept** the comment without quotation marks.

**Q3. C-13 names Q-IP-04 where the SRS names Q-IP-05.** Question Q-IP-05 is not in content 5.0.0, and C-13 reaches 16 questions there. The notebook names Q-IP-04 (performance metrics for each subgroup), Q-IP-06, Q-IP-14 and Q-IP-19, all in its linked list.
- Proposed: **accept** Q-IP-04 in place of Q-IP-05.

**Q4. C-05: the SRS names Q-PP-10 and Q-PP-06, which are not in content 5.0.0.** C-05's linked list has ten questions (Q-PP-03, 04, 05, 24, 09, 16, 17, 18, 20, 22). The notebook's when-to-use list and its evidence summary name four of them: Q-PP-09 (is the training data representative), Q-PP-18 (selection bias in collection), Q-PP-22 (edge cases and rare conditions) and Q-PP-16 (the data quality assessments, here class imbalance and distribution across subgroups).
- Proposed: **accept** these four. The SRS index table is the stale side.

**Q5. Results that changed after review.** These numbers differ from what the first version printed. Please look at them in the executed copies.

- **C-10.** Before: 294 of 48,842 rows removed (0.6 percent); the average hours per week changed by 0.011 (women) and 0.025 (men); l = 2 reported. Cause: Adult writes the income of its test rows with a trailing full stop, so one value counted as two. After: 958 of 48,842 rows removed (2.0 percent), 151 groups left, k = 5 and a true l = 2; the averages change by 0.159 and 0.121.
- **C-16.** Before: all four languages read cannot tell, because the two designs' own ranges overlapped. After, using the paired difference on the same test articles: Hausa **separate looks better** (pooled minus separate -0.013, range -0.025 to -0.005); Luganda **pooled looks better** (+0.090, range 0.048 to 0.144); Swahili cannot tell (+0.017, range -0.014 to 0.062); Yoruba cannot tell (-0.005, range -0.017 to 0.008). The macro F1 numbers themselves are the same.
- **C-14.** Before: the trend check reported one flip, in the age band 10 to 20 (overall +0.008 against -0.007 inside that band, 534 people and only 26 cases). After: none, because the check now skips groups with too few cases. Every other table is unchanged (recall: 18 groups cannot tell, 8 below overall, 4 above; overall AUC 0.649).
- **C-18.** Before, the explanation for case 0 said the estimate was raised by "other instalment plans none, duration months, other instalment plans bank" and lowered by "status checking no checking account, status checking under 0 DM, credit history ...", which named categories the person is not in. After: raised by "other instalment plans (bank), duration months (18.0), credit amount (629.0)"; lowered by "status checking (no checking account), credit history (critical account or other credits), residence since (3.0)".
- Proposed: **accept** all four as the corrected results.

**Q6. Other points the reviewers raised, with a default each.**

- C-10 and Q-IP-11: restored with narrow wording (this notebook helps only for its own steps). Proposed: keep. The other choice is to drop the link and list the narrowing for you.
- C-18 and Q-IP-01 (justify the choice of model architecture): the reviewer called it the thinnest link; the notebook says it does not compare model types. Proposed: keep with the limit stated.
- C-14: groups below the size rule are in the printed tables and counted in the summary, but not named in the evidence files. The guidance for Q-IP-04 says such groups should be named as such. Naming them needs care, because some groups have one or two people. Proposed: leave as is.
- C-03: the SRS index says 17 linked questions; content 5.0.0 gives 16. The notebook follows the content.
- The notebooks ran in 4 seconds to 1 minute 21 seconds on two cores. The title of each notebook says 1 to 5 minutes for an ordinary laptop. Proposed: leave as is.

## Batch hash: the files as they stand

SHA-256 of each notebook source at `46e49ddb`, so your pass is for these exact bytes. A pass given to an edited notebook is for its new hash.

| Notebook | sha256 |
|---|---|
| C-13 | `a7aa2b5456ff9f994a3ecc4ddb98be23136e086d01e1116e507f44799c31c98b` |
| C-14 | `6c28b2673aca6a44ed70d22d300896a41ed7fd62c8b29dc20a414a684ecf48ea` |
| C-21 | `c938055f5331d2395e7f0b144970d8a9d947de6704dcbe951ee55739fd4ea0cc` |
| C-18 | `454452565c34b2a51db9d3a4a24bc6a1f87d8df91ad3a09f9260dc12e21b8fba` |
| C-03 | `a478bc653ebb0afe7687683a9400453be53404620947199c65c3bc39c297bca1` |
| C-04 | `4b7423006c177a7426c7df7c86bb611ac483a5e081c915f53ac75f9c19f3341a` |
| C-15 | `267249dce3a37818fb60e771913b1a700cd47d9244d5446384be94f31f36abbd` |
| C-05 | `8bd325cce56c08ccfde3cb5da20f932042f40fb7ef79356bcbbb3621241a3e48` |
| C-16 | `9827ce699cc329e9c223d51f064f295503b98d09e07adf2e309db08f1ee9367c` |
| C-10 | `46df30a6b7c5506491967a3944878ce1626592be852fc9121936e9d2be0d8159` |

## Answers recorded on 6 November 2026

The owner passed all ten notebooks on the hashes above ("C-13: pass, C-14: pass, C-21: pass, C-18: pass, C-03: pass, C-04: pass, C-15: pass, C-05: pass, C-16: pass, C-10: pass") and answered "Questions as proposed". The reviewer is "Product owner, MAK-AI" for all ten, and for C-10 as the privacy-competent reviewer (OD-03). The answers are recorded in each notebook's review file under "Domain review", and verbatim in records/plans/2026-10-29-v1-plan/reviews/owner-questions.md. C-16 item 8 is settled: the Q-PO-12 paragraph stays.

