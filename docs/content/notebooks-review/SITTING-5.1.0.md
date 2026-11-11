# Sitting 5.1.0: the ten technical notebooks write one ZIP

## The owner's answer

On 11 November 2026 at 22:55 EAT the owner was shown the ten notebooks with the first 12 characters of the hashes in the "Batch hash" table below, and was asked to pass them, with C-10 passed as its privacy-competent reviewer as on 6 November. The owner answered "Pass all ten (Recommended)". The outcome is pass, with no edits, for all ten notebooks, and the reviewer is "Product owner, MAK-AI". The passes are recorded in each notebook's review file, below the record of 6 November.

The rest of this note is as the owner read it.

Prepared for the owner's second look at the ten technical notebooks. The first sitting is in `SITTING.md` and the answers of 6 November 2026 are in each notebook's review file; neither is changed. Nothing here is approved in advance. A pass is tied to the exact bytes whose hashes are below.

## Why the notebooks changed

Each notebook told the reader to attach its summary "with the CSV and PNG files beside it". The platform takes one file as evidence, and a ZIP is a file it accepts (first bytes `PK`, up to 10 MiB). A person cannot attach a summary and a folder of tables in one upload. Each notebook now writes `<C>_evidence.zip` next to the `evidence` folder, after the summary is written, and tells the reader to attach that one file. The ZIP holds the files in `evidence` whose names start with that notebook's control id (for example `C-13_`): its summary, tables and pictures, and nothing else, even when other notebooks have written to the same folder. It holds no data file. The ZIP is built under the name `<C>_evidence.zip.part` and moved onto `<C>_evidence.zip` only when it is complete, and any earlier ZIP of that name is removed first. An error while the ZIP is being built therefore leaves no ZIP under the final name; a run that fails earlier leaves the previous run's ZIP, and the error shows on screen. A half-built `.part` file may remain beside the folder, never in it, and is not attached. The folder itself is unchanged, so the evidence checker applies to it as before.

Content 5.1.0 also changed the version stamp in each notebook's linked-content cell, from 5.0.0 to 5.1.0. That is one line per notebook and is shown below.

## What you are asked to pass

The ten files below, by hash. The changes are the ones listed here and the version stamp described above; every other cell, its outputs, its tags and its ids are the same bytes you passed on 6 November. Each notebook's own cell diff follows.

- Cell 22 of C-10 (the print line) and cell 23 of C-10 now name the ZIP instead of "this summary".
- Cell 2 of C-15 and cell 2 of C-16 said "the summary"; they now name the ZIP.
- Each notebook gains `import zipfile` and a short archive step in its evidence-summary cell: remove any earlier `<C>_evidence.zip`, add the files named `<C>_*` in `evidence` to `<C>_evidence.zip.part` in sorted order under their file names, then move the `.part` file onto `<C>_evidence.zip`.
- Cell 19 of C-21 (the stop-and-decide cell) had the sentence "The plan is written to a file you can attach." It now reads "The plan is written to a file, and the evidence ZIP includes it." It says nothing else about attaching.
- The linked-content cell of each notebook carries the stamp "Generated from content 5.1.0" in place of 5.0.0 (one line, from the content release).

The new sentence, as it reads in each summary (the question list and the clause about what the file holds differ by notebook):

> Attach the file `C-13_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions ...). It holds this notebook's own summary, tables and pictures, numbers only, never the data.

C-10 says "summary and tables" because it writes no pictures. C-21 says "summary, tables, pictures and monitoring plan". C-15 says "as closure evidence of a mitigation marked 'follows C-15'" in place of "to the decision it supports".

## How to answer

- One line per notebook: **"C-xx: pass"**, **"C-xx: fail"**, or **"C-xx: pass with edits <what>"**. An edit changes the file and its hash, and you then pass the new hash.
- Reviewer: by default **Product owner, MAK-AI**; for C-10, the privacy-competent reviewer you named on 6 November.
- Order as before: C-13, C-14, C-21, C-18, C-03, C-04, C-15, C-05, C-16, then C-10 on its own.

## What was run, and what was not

Run: each of the ten notebook sources with `scripts/notebooks/run_notebooks.py --only <file>`, first on its own, and then all ten one after another in one shared folder (below). The runs used the locked environment (`notebooks/requirements.txt`, Python 3.12) and the datasets already in the local cache, inside a network namespace with no route out, so nothing could be downloaded. All ten exited 0. For each, the ZIP was opened and its file list compared with the folder's (equal), its first four bytes read (`PK\x03\x04`), and `notebooks/tools/check_evidence.py` run on the folder against the cached data files (results in each section; summary below).

Also run: `python3 -m unittest notebooks/tools/test_tools.py` (30 tests, all OK, including three cases that run each notebook's archive step: one checks the ZIP's first bytes, its size and that the evidence checker still accepts the folder; one puts another control's files, a stray file, a folder, a link and an older ZIP in the folder and checks the ZIP holds this control's files only; one raises an error while members are being added and checks that no ZIP is left and the earlier one is gone), and the notebook content tests.

Not run:

- The Notebooks workflow on this commit. It has not run.
- A clean run with fresh downloads. The runs above used cached data.
- The executed web-page copies and run logs that came with the first sitting. They were not made again; the runs above are the evidence for this change.
- `python3 scripts/notebooks/run_notebooks.py --check-only` stops with an error, and the released-copy test in `__tests__/content/notebooks.test.ts` reports a difference, until the files in `public/notebooks` and `data/resources.json` take the new hashes after your pass.
- Uploading a ZIP to the platform as evidence. That is checked after your pass.

Evidence checker, exit code per notebook: C-13 0, C-14 0, C-21 0, C-18 0, C-03 0, C-04 0, C-15 0, C-05 0, C-16 0, C-10 0.

Then all ten were run again, one after another, in one shared scratch folder (the side-by-side case), so each later ZIP was written with the earlier notebooks' files already in `evidence`. All ten exited 0. Each ZIP's member list is exactly that notebook's own files (none starts with another control id), first bytes `PK\x03\x04`:

- C-13: `C-13_calibration.png`, `C-13_calibration_by_group.csv`, `C-13_gap_intervals.csv`, `C-13_gaps.csv`, `C-13_metrics_by_group.csv`, `C-13_summary.md`
- C-14: `C-14_overall.csv`, `C-14_per_group.csv`, `C-14_recall_by_group.png`, `C-14_summary.md`
- C-21: `C-21_alerts_by_window.csv`, `C-21_drift.png`, `C-21_group_gaps_by_window.csv`, `C-21_ks_by_window.csv`, `C-21_monitoring_plan.md`, `C-21_performance_by_window.csv`, `C-21_psi_by_window.csv`, `C-21_summary.md`
- C-18: `C-18_noise_sensitivity.csv`, `C-18_partial_dependence.png`, `C-18_permutation_importance.csv`, `C-18_permutation_importance.png`, `C-18_planted_leak_importance.csv`, `C-18_seed_stability.csv`, `C-18_shap_bar.png`, `C-18_shap_summary.png`, `C-18_small_change_sensitivity.csv`, `C-18_summary.md`
- C-03: `C-03_duplicates.csv`, `C-03_makeup.csv`, `C-03_makeup.png`, `C-03_missing_by_group.csv`, `C-03_outliers.csv`, `C-03_schema.csv`, `C-03_summary.md`, `C-03_validity.csv`
- C-04: `C-04_annotator_agreement.csv`, `C-04_associations.csv`, `C-04_label_rates.csv`, `C-04_label_tests.csv`, `C-04_overview.png`, `C-04_proxy_test.csv`, `C-04_summary.md`
- C-15: `C-15_comparison.csv`, `C-15_summary.md`, `C-15_trade_off.png`
- C-05: `C-05_class_balance.csv`, `C-05_distribution.png`, `C-05_goodness_of_fit.csv`, `C-05_group_counts.csv`, `C-05_intersection.csv`, `C-05_reference_comparison.csv`, `C-05_summary.md`
- C-16: `C-16_comparison.png`, `C-16_decision_table.csv`, `C-16_group_intervals.csv`, `C-16_leakage_check.csv`, `C-16_small_group_curve.csv`, `C-16_summary.md`
- C-10: `C-10_column_classification.csv`, `C-10_cost.csv`, `C-10_k_and_l.csv`, `C-10_summary.md`

Evidence checker on the shared folder, per control: C-13 0, C-14 0, C-21 0, C-18 0, C-03 0, C-04 0, C-15 0, C-05 0, C-16 0, C-10 0.

Files each notebook writes, read from its cells: tables, pictures and a summary into `evidence`, every name starting with its own control id (C-21's monitoring plan included), and, on a first run, the downloaded dataset into the local cache. C-10 writes no anonymised data, pseudonym or key to disk.

## Notebooks

### C-13 Subgroup Fairness Metrics

| | |
|---|---|
| Source | `notebooks/technical/C-13_subgroup-fairness.ipynb` |
| Bytes | 36,700 |
| New source SHA-256 | `d15d2191242b5fe6c5963e5a798b62812ad138c08156cbba18d37bdc8201958b` |
| Passed on 6 November | `a7aa2b5456ff9f994a3ecc4ddb98be23136e086d01e1116e507f44799c31c98b` |
| Offline run | exit 0, 112 seconds; wrote `C-13_evidence.zip` (104,873 bytes, 6 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 19, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-IP-04, Q-IP-06, Q-IP-14, Q-IP-19). It holds numbers only, never the data.
+Attach the file `C-13_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-IP-04, Q-IP-06, Q-IP-14, Q-IP-19). It holds this notebook's own summary, tables and pictures, numbers only, never the data.
+# One ZIP of this control's own files (names starting 'C-13_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-13_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-13_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-13_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-13_evidence.zip.part', 'C-13_evidence.zip')
```

### C-14 Disaggregated Performance Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-14_disaggregated-performance.ipynb` |
| Bytes | 38,353 |
| New source SHA-256 | `d9de5527fea34bc2115a96ec9aac1a322c43ed3a827d5ddb620ddba3eadc877e` |
| Passed on 6 November | `6c28b2673aca6a44ed70d22d300896a41ed7fd62c8b29dc20a414a684ecf48ea` |
| Offline run | exit 0, 45 seconds; wrote `C-14_evidence.zip` (70,059 bytes, 4 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 21, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-IP-04, Q-IP-14, Q-IP-19). The per-group table is the one to copy into the model card's disaggregated results table. It holds numbers only, never the data.
+Attach the file `C-14_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-IP-04, Q-IP-14, Q-IP-19). The per-group table is the one to copy into the model card's disaggregated results table. It holds this notebook's own summary, tables and pictures, numbers only, never the data.
+# One ZIP of this control's own files (names starting 'C-14_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-14_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-14_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-14_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-14_evidence.zip.part', 'C-14_evidence.zip')
```

### C-21 Monitoring and Drift Detection

| | |
|---|---|
| Source | `notebooks/technical/C-21_monitoring-drift.ipynb` |
| Bytes | 34,705 |
| New source SHA-256 | `876fcdac343c6651bc58297c7bae6c15129de3833e1277214bfef2efaebf66fa` |
| Passed on 6 November | `c938055f5331d2395e7f0b144970d8a9d947de6704dcbe951ee55739fd4ea0cc` |
| Offline run | exit 0, 5 seconds; wrote `C-21_evidence.zip` (64,838 bytes, 8 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 19, the stop-and-decide cell:

```diff
-Write your choices below. Leave a field blank if you have not decided, and the plan will say so. The plan is written to a file you can attach.
+Write your choices below. Leave a field blank if you have not decided, and the plan will say so. The plan is written to a file, and the evidence ZIP includes it.
```

Cell 21, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV, PNG and plan files beside it, to the decision it supports (questions Q-PO-01, Q-PO-02, Q-PO-17, Q-PO-18, Q-IP-24, Q-PP-20). It holds numbers only, never the data.
+Attach the file `C-21_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-PO-01, Q-PO-02, Q-PO-17, Q-PO-18, Q-IP-24, Q-PP-20). It holds this notebook's own summary, tables, pictures and monitoring plan, numbers only, never the data.
+# One ZIP of this control's own files (names starting 'C-21_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-21_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-21_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-21_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-21_evidence.zip.part', 'C-21_evidence.zip')
```

### C-18 Explainability Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-18_explainability-analysis.ipynb` |
| Bytes | 42,662 |
| New source SHA-256 | `d8fd64aa3d2bec94e30c7e8bf5f4d62e3a9a0246493459b4715997eeefc6fc2f` |
| Passed on 6 November | `454452565c34b2a51db9d3a4a24bc6a1f87d8df91ad3a09f9260dc12e21b8fba` |
| Offline run | exit 0, 15 seconds; wrote `C-18_evidence.zip` (189,670 bytes, 10 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 26, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-IP-07, Q-IP-17, Q-IP-08, Q-IP-22, Q-IP-01). It holds numbers and pictures about the model as a whole, never the data and never one person's record.
+Attach the file `C-18_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-IP-07, Q-IP-17, Q-IP-08, Q-IP-22, Q-IP-01). It holds this notebook's own summary, tables and pictures, about the model as a whole, never the data and never one person's record.
+# One ZIP of this control's own files (names starting 'C-18_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-18_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-18_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-18_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-18_evidence.zip.part', 'C-18_evidence.zip')
```

### C-03 Data Quality and Representativeness Audit

| | |
|---|---|
| Source | `notebooks/technical/C-03_data-quality-audit.ipynb` |
| Bytes | 39,727 |
| New source SHA-256 | `c1d2f4d1efaab0c06899f263a0d95a0eac7f94eb427e76d3a04df1c075560192` |
| Passed on 6 November | `a478bc653ebb0afe7687683a9400453be53404620947199c65c3bc39c297bca1` |
| Offline run | exit 0, 5 seconds; wrote `C-03_evidence.zip` (39,720 bytes, 8 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 22, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-PP-09, Q-PP-16, Q-PP-22, Q-IP-11). It holds counts and shares only, never the data.
+Attach the file `C-03_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-PP-09, Q-PP-16, Q-PP-22, Q-IP-11). It holds this notebook's own summary, tables and pictures, counts and shares only, never the data.
+# One ZIP of this control's own files (names starting 'C-03_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-03_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-03_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-03_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-03_evidence.zip.part', 'C-03_evidence.zip')
```

### C-04 Bias Detection in Data

| | |
|---|---|
| Source | `notebooks/technical/C-04_bias-detection.ipynb` |
| Bytes | 33,074 |
| New source SHA-256 | `d72f47d51dd1216fe7e431827593fe2bf5371b37f18208d9ac8d11203416f0c2` |
| Passed on 6 November | `4b7423006c177a7426c7df7c86bb611ac483a5e081c915f53ac75f9c19f3341a` |
| Offline run | exit 0, 7 seconds; wrote `C-04_evidence.zip` (44,612 bytes, 7 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 18, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-PP-11, Q-PP-12, Q-PP-17, Q-PP-19). It holds numbers only, never the data. The annotator table is synthetic and describes no real people.
+Attach the file `C-04_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-PP-11, Q-PP-12, Q-PP-17, Q-PP-19). It holds this notebook's own summary, tables and pictures, numbers only, never the data. The annotator table is synthetic and describes no real people.
+# One ZIP of this control's own files (names starting 'C-04_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-04_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-04_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-04_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-04_evidence.zip.part', 'C-04_evidence.zip')
```

### C-15 Bias Mitigation Techniques

| | |
|---|---|
| Source | `notebooks/technical/C-15_bias-mitigation.ipynb` |
| Bytes | 30,649 |
| New source SHA-256 | `640ed7d875db4af960f252b81b7b71f87e5abda862586867e497bfbdcc63b28b` |
| Passed on 6 November | `267249dce3a37818fb60e771913b1a700cd47d9244d5446384be94f31f36abbd` |
| Offline run | exit 0, 33 seconds; wrote `C-15_evidence.zip` (36,036 bytes, 3 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 2, the when-to-use cell:

```diff
-The summary this notebook writes can be attached as closure evidence of a mitigation recorded on the platform, marked "follows C-15".
+The ZIP file this notebook writes, `C-15_evidence.zip`, can be attached as closure evidence of a mitigation recorded on the platform, marked "follows C-15".
```

Cell 19, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, as closure evidence of a mitigation marked "follows C-15" (questions Q-IP-15, Q-IP-06, Q-IP-19). It holds numbers only, never the data.
+Attach the file `C-15_evidence.zip`, which the notebook writes next to the `evidence` folder, as closure evidence of a mitigation marked "follows C-15" (questions Q-IP-15, Q-IP-06, Q-IP-19). It holds this notebook's own summary, tables and pictures, numbers only, never the data.
+# One ZIP of this control's own files (names starting 'C-15_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-15_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-15_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-15_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-15_evidence.zip.part', 'C-15_evidence.zip')
```

### C-05 Data Distribution Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-05_data-distribution.ipynb` |
| Bytes | 29,365 |
| New source SHA-256 | `2df7462ace468b106b963073f3f4410442bd03abf6a9163c541f096b796b19b4` |
| Passed on 6 November | `8bd325cce56c08ccfde3cb5da20f932042f40fb7ef79356bcbbb3621241a3e48` |
| Offline run | exit 0, 4 seconds; wrote `C-05_evidence.zip` (59,379 bytes, 7 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 17, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-PP-09, Q-PP-16, Q-PP-18, Q-PP-22). It holds counts and shares only, never the data.
+Attach the file `C-05_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-PP-09, Q-PP-16, Q-PP-18, Q-PP-22). It holds this notebook's own summary, tables and pictures, counts and shares only, never the data.
+# One ZIP of this control's own files (names starting 'C-05_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-05_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-05_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-05_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-05_evidence.zip.part', 'C-05_evidence.zip')
```

### C-16 Stratified Model Evaluation

| | |
|---|---|
| Source | `notebooks/technical/C-16_stratified-evaluation.ipynb` |
| Bytes | 36,072 |
| New source SHA-256 | `620f1e82658f586575e1080ab1c2f0d7a72d7ef38fa6f5c33899a462b122cf9d` |
| Passed on 6 November | `9827ce699cc329e9c223d51f064f295503b98d09e07adf2e309db08f1ee9367c` |
| Offline run | exit 0, 133 seconds; wrote `C-16_evidence.zip` (48,641 bytes, 6 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 2, the when-to-use cell:

```diff
-A team may also attach the summary to `Q-PO-12` (performance across languages after deployment), although the framework does not link that question to this control.
+A team may also attach `C-16_evidence.zip` to `Q-PO-12` (performance across languages after deployment), although the framework does not link that question to this control.
```

Cell 20, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV and PNG files beside it, to the decision it supports (questions Q-IP-02, Q-IP-04, Q-IP-13, Q-IP-14, Q-IP-19; also Q-PO-12, which the framework does not link, if it fits). It holds scores only, never the data.
+Attach the file `C-16_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-IP-02, Q-IP-04, Q-IP-13, Q-IP-14, Q-IP-19; also Q-PO-12, which the framework does not link, if it fits). It holds this notebook's own summary, tables and pictures, scores only, never the data.
+# One ZIP of this control's own files (names starting 'C-16_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-16_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-16_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-16_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-16_evidence.zip.part', 'C-16_evidence.zip')
```

### C-10 Privacy and Anonymization Protocols

| | |
|---|---|
| Source | `notebooks/technical/C-10_privacy-anonymization.ipynb` |
| Bytes | 37,361 |
| New source SHA-256 | `9db224342cb7dd7003399fe47d752fec7bf1938c4839f9013967ffc13150cb8c` |
| Passed on 6 November | `46df30a6b7c5506491967a3944878ce1626592be852fc9121936e9d2be0d8159` |
| Offline run | exit 0, 5 seconds; wrote `C-10_evidence.zip` (2,304 bytes, 4 files, starts with `PK`) |
| Evidence checker on the folder | exit 0 |

Text that changed, against the bytes you passed:

Cell 1, the linked-content cell (content version stamp):

```diff
-Generated from content 5.0.0. Do not edit by hand.
+Generated from content 5.1.0. Do not edit by hand.
```

Cell 22, the evidence-summary cell (writes the ZIP and says what to attach):

```diff
+import zipfile
+
-Attach this file, with the CSV files beside it, to the decision it supports (questions Q-PP-14, Q-PP-21, Q-IP-11). It holds counts and column names only: no row of the data, no pseudonym, no key.
+Attach the file `C-10_evidence.zip`, which the notebook writes next to the `evidence` folder, to the decision it supports (questions Q-PP-14, Q-PP-21, Q-IP-11). It holds this notebook's own summary and tables, counts and column names only: no row of the data, no pseudonym, no key.
+# One ZIP of this control's own files (names starting 'C-10_'), written next to the folder, not inside it.
+# It is built under a .part name and moved into place only when complete, so an error while it is built leaves no ZIP.
+# No file named for another control can enter it.
+Path('C-10_evidence.zip').unlink(missing_ok=True)
+with zipfile.ZipFile('C-10_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
+    for path in sorted(EVIDENCE_DIR.glob('C-10_*')):
+        if path.is_file() and not path.is_symlink():
+            archive.write(path, path.name)
+os.replace('C-10_evidence.zip.part', 'C-10_evidence.zip')
-print('WARNING: never upload the anonymised data, its pseudonyms or the key to the MAK-AI platform. Attach this summary only.')
+print('WARNING: never upload the anonymised data, its pseudonyms or the key to the MAK-AI platform. Attach only C-10_evidence.zip.')
```

Cell 23, the closing cell:

```diff
-- **The platform must never see this data.** Keep it on your own machine. Attach only the summary this notebook writes.
+- **The platform must never see this data.** Keep it on your own machine. Attach only the ZIP file this notebook writes, `C-10_evidence.zip`.
```

## Batch hash: the files as they stand

SHA-256 of each notebook source, so your pass is for these exact bytes.

| Notebook | Bytes | sha256 |
|---|---|---|
| C-13 | 36,700 | `d15d2191242b5fe6c5963e5a798b62812ad138c08156cbba18d37bdc8201958b` |
| C-14 | 38,353 | `d9de5527fea34bc2115a96ec9aac1a322c43ed3a827d5ddb620ddba3eadc877e` |
| C-21 | 34,705 | `876fcdac343c6651bc58297c7bae6c15129de3833e1277214bfef2efaebf66fa` |
| C-18 | 42,662 | `d8fd64aa3d2bec94e30c7e8bf5f4d62e3a9a0246493459b4715997eeefc6fc2f` |
| C-03 | 39,727 | `c1d2f4d1efaab0c06899f263a0d95a0eac7f94eb427e76d3a04df1c075560192` |
| C-04 | 33,074 | `d72f47d51dd1216fe7e431827593fe2bf5371b37f18208d9ac8d11203416f0c2` |
| C-15 | 30,649 | `640ed7d875db4af960f252b81b7b71f87e5abda862586867e497bfbdcc63b28b` |
| C-05 | 29,365 | `2df7462ace468b106b963073f3f4410442bd03abf6a9163c541f096b796b19b4` |
| C-16 | 36,072 | `620f1e82658f586575e1080ab1c2f0d7a72d7ef38fa6f5c33899a462b122cf9d` |
| C-10 | 37,361 | `9db224342cb7dd7003399fe47d752fec7bf1938c4839f9013967ffc13150cb8c` |
