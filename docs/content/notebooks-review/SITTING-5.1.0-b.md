# Sitting 5.1.0 (b): the ten technical notebooks, a third look

Prepared for the owner's third look at the ten technical notebooks. The note of 11 November 2026, `SITTING-5.1.0.md`, is what the owner read and answered that day; it is not changed. Nothing here is approved in advance. A pass is tied to the exact bytes whose hashes are below.

## Why the notebooks changed

A security review of the branch raised two points, both about the step that writes `<C>_evidence.zip`. Both are fixed in each notebook's evidence-summary cell.

1. The step put every regular file in `evidence` whose name starts with the notebook's control id into the ZIP. A person who keeps their own file there under that prefix, for example `C-10_anonymised.csv`, would have had it zipped. The platform accepts a ZIP without opening it, while a CSV on its own cannot be uploaded at all. The step now holds a list of the file names the notebook itself writes, and adds only those. Nothing else in the folder can enter the ZIP: only the files the cell itself wrote can. That those files hold no data rows rests on how the cell builds them (small tables of counts, shares and numbers, and pictures) and on `check_evidence.py`, which refuses a folder that holds a row of the data. If a listed file is missing, or is a link and not a plain file, the cell stops, no ZIP is left under the final name, and the message names the file and says what to do: "<name> is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first."
2. If a link already existed at the name `<C>_evidence.zip.part`, the step would have written the ZIP through the link into whatever it points at. The step now removes anything at that name first and creates the file in a way that stops with an error if something appears there in the meantime, instead of writing through it.

The order of the step is: remove any earlier `<C>_evidence.zip`; remove any `<C>_evidence.zip.part`; create the `.part` file; add the listed files; when that has finished without error, move the `.part` file onto `<C>_evidence.zip`. An error while the ZIP is being built leaves no ZIP under the final name; a run that stops earlier leaves the previous run's ZIP, and the error shows on screen.

## What you are asked to pass

The ten files below, by hash. Only the evidence-summary cell of each notebook changed since the bytes you passed on 11 November, and in it only the archive step, its comment lines and the sentence of its error message. No line that writes a file, no sentence a person reads and no other cell changed. The exact text follows for each notebook.

## How to answer

- One line per notebook: **"C-xx: pass"**, **"C-xx: fail"**, or **"C-xx: pass with edits <what>"**. An edit changes the file and its hash, and you then pass the new hash.
- Reviewer: by default **Product owner, MAK-AI**; for C-10, the privacy-competent reviewer you named on 6 November.
- Order as before: C-13, C-14, C-21, C-18, C-03, C-04, C-15, C-05, C-16, then C-10 on its own.

## What was run, and what was not

Run: each of the ten notebook sources with `scripts/notebooks/run_notebooks.py --only <file>`, first on its own and then all ten one after another in one shared folder. The runs used the locked environment (`notebooks/requirements.txt`, Python 3.12) and the datasets already in the local cache, inside a network namespace with no route out, so nothing could be downloaded. All twenty runs exited 0. For each run the ZIP was opened and its member list compared with the list in the cell (equal, in sorted order), its first four bytes read (`PK\x03\x04`), and no `.part` file was left. `notebooks/tools/check_evidence.py` was run on each notebook's own folder and, for the shared run, on the shared folder, against the cached data files: exit codes C-13 0, C-14 0, C-21 0, C-18 0, C-03 0, C-04 0, C-15 0, C-05 0, C-16 0, C-10 0 and, shared, C-13 0, C-14 0, C-21 0, C-18 0, C-03 0, C-04 0, C-15 0, C-05 0, C-16 0, C-10 0.

Those twenty runs were made before the last edit, which changed only the sentence of the error message for a missing or linked file; the code around it is the same. After that edit, C-10 was run again on its own on the final bytes (exit 0; its ZIP holds the four listed files, `C-10_column_classification.csv`, `C-10_cost.csv`, `C-10_k_and_l.csv` and `C-10_summary.md`; the evidence checker exit 0), and the tools test that removes a listed file (and one that replaces it with a link) was run again and checks the new sentence.

Also run: `python3 -m unittest notebooks/tools/test_tools.py` (32 tests, all OK), which runs each notebook's archive step against a folder holding the listed files together with another control's files, a file of the person's own with this control's prefix, a stray file, a folder, a link and an older ZIP, and checks the ZIP holds exactly the listed files; with a link planted at the `.part` name pointing at a file outside the folder, and checks that file is unchanged; with a listed file missing or replaced by a link, and checks the step stops and leaves no ZIP; and with an error raised while files are being added. The notebook content tests also ran.

Not run:

- The Notebooks workflow on this commit.
- A clean run with fresh downloads. The runs above used cached data.
- Uploading the new ZIP to the platform as evidence. The upload check was made once, in the local app, on 11 November 2026 (the platform recorded the upload at 20:07 UTC), with the C-13 ZIP written by the notebook the owner passed that day (the bytes of commit 627593d2, C-13 sha256 `d15d2191242b5fe6c5963e5a798b62812ad138c08156cbba18d37bdc8201958b`). It has not been repeated with these bytes; it is repeated after your pass.
- The executed web-page copies and run logs of the first sitting.
- `python3 scripts/notebooks/run_notebooks.py --check-only` and the released-copy test in `__tests__/content/notebooks.test.ts` report a difference, because the released copies in `public/notebooks` and the records in `data/resources.json` and the review files still hold the bytes you passed on 11 November. They take the new hashes after your pass.

## Notebooks

### C-13 Subgroup Fairness Metrics

| | |
|---|---|
| Source | `notebooks/technical/C-13_subgroup-fairness.ipynb` |
| Bytes | 37,084 |
| New source SHA-256 | `5b4bd7303e779ae7cb92df9da29673f57855adbcdf81c18946638757b1b60550` |
| Passed on 11 November | `d15d2191242b5fe6c5963e5a798b62812ad138c08156cbba18d37bdc8201958b` |
| Cell that changed | cell 19, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 148 seconds; `C-13_evidence.zip` holds exactly the 6 listed files |
| Offline run in the shared folder | exit 0; the same 6 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-13_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-13_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-13_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-13_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-13_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-13_calibration.png', 'C-13_calibration_by_group.csv', 'C-13_gap_intervals.csv',
+        'C-13_gaps.csv', 'C-13_metrics_by_group.csv', 'C-13_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-14 Disaggregated Performance Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-14_disaggregated-performance.ipynb` |
| Bytes | 38,661 |
| New source SHA-256 | `7e4101a3ffd081bca911419ec618f3717b4630d3086d376dfea024b58a813eba` |
| Passed on 11 November | `d9de5527fea34bc2115a96ec9aac1a322c43ed3a827d5ddb620ddba3eadc877e` |
| Cell that changed | cell 21, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 53 seconds; `C-14_evidence.zip` holds exactly the 4 listed files |
| Offline run in the shared folder | exit 0; the same 4 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-14_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-14_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-14_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-14_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-14_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-14_overall.csv', 'C-14_per_group.csv', 'C-14_recall_by_group.png', 'C-14_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-21 Monitoring and Drift Detection

| | |
|---|---|
| Source | `notebooks/technical/C-21_monitoring-drift.ipynb` |
| Bytes | 35,169 |
| New source SHA-256 | `fdd279abaebe86a8eb702850685ad813c3305556e3531978b8f5d2766e3796c6` |
| Passed on 11 November | `876fcdac343c6651bc58297c7bae6c15129de3833e1277214bfef2efaebf66fa` |
| Cell that changed | cell 21, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 5 seconds; `C-21_evidence.zip` holds exactly the 8 listed files |
| Offline run in the shared folder | exit 0; the same 8 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-21_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-21_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-21_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-21_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-21_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-21_alerts_by_window.csv', 'C-21_drift.png', 'C-21_group_gaps_by_window.csv',
+        'C-21_ks_by_window.csv', 'C-21_monitoring_plan.md', 'C-21_performance_by_window.csv',
+        'C-21_psi_by_window.csv', 'C-21_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-18 Explainability Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-18_explainability-analysis.ipynb` |
| Bytes | 43,228 |
| New source SHA-256 | `08aa9226fcf89b677c609127614896f6e5bea1cbb69af900e75891ff395a1802` |
| Passed on 11 November | `d8fd64aa3d2bec94e30c7e8bf5f4d62e3a9a0246493459b4715997eeefc6fc2f` |
| Cell that changed | cell 26, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 15 seconds; `C-18_evidence.zip` holds exactly the 10 listed files |
| Offline run in the shared folder | exit 0; the same 10 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-18_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-18_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-18_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-18_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-18_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-18_noise_sensitivity.csv', 'C-18_partial_dependence.png', 'C-18_permutation_importance.csv',
+        'C-18_permutation_importance.png', 'C-18_planted_leak_importance.csv',
+        'C-18_seed_stability.csv', 'C-18_shap_bar.png', 'C-18_shap_summary.png',
+        'C-18_small_change_sensitivity.csv', 'C-18_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-03 Data Quality and Representativeness Audit

| | |
|---|---|
| Source | `notebooks/technical/C-03_data-quality-audit.ipynb` |
| Bytes | 40,133 |
| New source SHA-256 | `e9bbf24cf1929a21f812853725a726038c78558e9641993eb9d40951cf992bbd` |
| Passed on 11 November | `c1d2f4d1efaab0c06899f263a0d95a0eac7f94eb427e76d3a04df1c075560192` |
| Cell that changed | cell 22, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 8 seconds; `C-03_evidence.zip` holds exactly the 8 listed files |
| Offline run in the shared folder | exit 0; the same 8 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-03_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-03_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-03_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-03_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-03_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-03_duplicates.csv', 'C-03_makeup.csv', 'C-03_makeup.png', 'C-03_missing_by_group.csv',
+        'C-03_outliers.csv', 'C-03_schema.csv', 'C-03_summary.md', 'C-03_validity.csv'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-04 Bias Detection in Data

| | |
|---|---|
| Source | `notebooks/technical/C-04_bias-detection.ipynb` |
| Bytes | 33,478 |
| New source SHA-256 | `ac3f3c3b81fc488eb4aaaad60302ac5be92e14ad1380d39cf3296260fd48ca5b` |
| Passed on 11 November | `d72f47d51dd1216fe7e431827593fe2bf5371b37f18208d9ac8d11203416f0c2` |
| Cell that changed | cell 18, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 9 seconds; `C-04_evidence.zip` holds exactly the 7 listed files |
| Offline run in the shared folder | exit 0; the same 7 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-04_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-04_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-04_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-04_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-04_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-04_annotator_agreement.csv', 'C-04_associations.csv', 'C-04_label_rates.csv',
+        'C-04_label_tests.csv', 'C-04_overview.png', 'C-04_proxy_test.csv', 'C-04_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-15 Bias Mitigation Techniques

| | |
|---|---|
| Source | `notebooks/technical/C-15_bias-mitigation.ipynb` |
| Bytes | 30,932 |
| New source SHA-256 | `37159c7a9933a63b118c915554fb6463011dc324c058c4310ac13a1f92c62f80` |
| Passed on 11 November | `640ed7d875db4af960f252b81b7b71f87e5abda862586867e497bfbdcc63b28b` |
| Cell that changed | cell 19, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 36 seconds; `C-15_evidence.zip` holds exactly the 3 listed files |
| Offline run in the shared folder | exit 0; the same 3 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-15_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-15_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-15_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-15_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-15_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-15_comparison.csv', 'C-15_summary.md', 'C-15_trade_off.png'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-05 Data Distribution Analysis

| | |
|---|---|
| Source | `notebooks/technical/C-05_data-distribution.ipynb` |
| Bytes | 29,799 |
| New source SHA-256 | `950009e0b79679c2b5e23a0976e5c2b2f0fad37c503c11abf764393b5bdccb73` |
| Passed on 11 November | `2df7462ace468b106b963073f3f4410442bd03abf6a9163c541f096b796b19b4` |
| Cell that changed | cell 17, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 6 seconds; `C-05_evidence.zip` holds exactly the 7 listed files |
| Offline run in the shared folder | exit 0; the same 7 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-05_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-05_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-05_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-05_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-05_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-05_class_balance.csv', 'C-05_distribution.png', 'C-05_goodness_of_fit.csv',
+        'C-05_group_counts.csv', 'C-05_intersection.csv', 'C-05_reference_comparison.csv',
+        'C-05_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-16 Stratified Model Evaluation

| | |
|---|---|
| Source | `notebooks/technical/C-16_stratified-evaluation.ipynb` |
| Bytes | 36,461 |
| New source SHA-256 | `81168f814925702f3c1e69be3db2b8e6131dc7721242cdc008846a02114c4935` |
| Passed on 11 November | `620f1e82658f586575e1080ab1c2f0d7a72d7ef38fa6f5c33899a462b122cf9d` |
| Cell that changed | cell 20, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 156 seconds; `C-16_evidence.zip` holds exactly the 6 listed files |
| Offline run in the shared folder | exit 0; the same 6 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-16_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-16_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-16_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-16_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-16_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-16_comparison.png', 'C-16_decision_table.csv', 'C-16_group_intervals.csv',
+        'C-16_leakage_check.csv', 'C-16_small_group_curve.csv', 'C-16_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

### C-10 Privacy and Anonymization Protocols

| | |
|---|---|
| Source | `notebooks/technical/C-10_privacy-anonymization.ipynb` |
| Bytes | 37,670 |
| New source SHA-256 | `1369680345eb6c8573d8058db8894f633edbde84a7fd3df30a73a1296086f772` |
| Passed on 11 November | `9db224342cb7dd7003399fe47d752fec7bf1938c4839f9013967ffc13150cb8c` |
| Cell that changed | cell 22, the evidence-summary cell (no other cell differs) |
| Offline run alone | exit 0, 8 seconds; `C-10_evidence.zip` holds exactly the 4 listed files |
| Offline run in the shared folder | exit 0; the same 4 files, no `.part` left |
| Evidence checker on the folder | exit 0 |

Text that changed since the 11 November pass (the archive step and its comment):

```diff
-# One ZIP of this control's own files (names starting 'C-10_'), written next to the folder, not inside it.
+# One ZIP of the files this cell wrote, next to the folder, not inside it. Only the files this cell wrote enter it.
-# No file named for another control can enter it.
-with zipfile.ZipFile('C-10_evidence.zip.part', 'w', zipfile.ZIP_DEFLATED) as archive:
-    for path in sorted(EVIDENCE_DIR.glob('C-10_*')):
-        if path.is_file() and not path.is_symlink():
-            archive.write(path, path.name)
+Path('C-10_evidence.zip.part').unlink(missing_ok=True)
+with zipfile.ZipFile('C-10_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED) as archive:
+    for name in [
+        'C-10_column_classification.csv', 'C-10_cost.csv', 'C-10_k_and_l.csv', 'C-10_summary.md'
+    ]:
+        path = EVIDENCE_DIR / name
+        if not path.is_file() or path.is_symlink():
+            raise RuntimeError(f'{name} is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')
+        archive.write(path, name)
```

## Batch hash: the files as they stand

SHA-256 of each notebook source, so your pass is for these exact bytes.

| Notebook | Bytes | sha256 |
|---|---|---|
| C-13 | 37,084 | `5b4bd7303e779ae7cb92df9da29673f57855adbcdf81c18946638757b1b60550` |
| C-14 | 38,661 | `7e4101a3ffd081bca911419ec618f3717b4630d3086d376dfea024b58a813eba` |
| C-21 | 35,169 | `fdd279abaebe86a8eb702850685ad813c3305556e3531978b8f5d2766e3796c6` |
| C-18 | 43,228 | `08aa9226fcf89b677c609127614896f6e5bea1cbb69af900e75891ff395a1802` |
| C-03 | 40,133 | `e9bbf24cf1929a21f812853725a726038c78558e9641993eb9d40951cf992bbd` |
| C-04 | 33,478 | `ac3f3c3b81fc488eb4aaaad60302ac5be92e14ad1380d39cf3296260fd48ca5b` |
| C-15 | 30,932 | `37159c7a9933a63b118c915554fb6463011dc324c058c4310ac13a1f92c62f80` |
| C-05 | 29,799 | `950009e0b79679c2b5e23a0976e5c2b2f0fad37c503c11abf764393b5bdccb73` |
| C-16 | 36,461 | `81168f814925702f3c1e69be3db2b8e6131dc7721242cdc008846a02114c4935` |
| C-10 | 37,670 | `1369680345eb6c8573d8058db8894f633edbde84a7fd3df30a73a1296086f772` |
