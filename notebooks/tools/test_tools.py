"""Tests for the notebook tools (run with the locked environment's interpreter):

    RUN_NOTEBOOKS_SCRIPT=<path> notebooks/.venv/bin/python -m unittest notebooks/tools/test_tools.py

Three things are proved here:
  * the executor C-NB relies on (SUG's scripts/notebooks/run_notebooks.py) skips cells
    tagged `optional` and exits 1 when a cell that runs raises (NB-AC-08, NB-AC-01);
  * check_evidence.py refuses an evidence folder that holds a row of the data, a long
    CSV, or a summary without package versions and the data file's SHA-256 (NB-AC-04);
  * check_evidence.py accepts a folder that has none of those faults.
"""
import ast
import hashlib
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.request
import zipfile
from pathlib import Path

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
REPO = Path(__file__).resolve().parents[2]
CHECK = Path(__file__).resolve().parent / "check_evidence.py"
EXECUTOR = Path(os.environ.get("RUN_NOTEBOOKS_SCRIPT", "scripts/notebooks/run_notebooks.py"))
if not EXECUTOR.is_absolute():
    EXECUTOR = REPO / EXECUTOR


def notebook(*cells):
    """A minimal nbformat 4.4 notebook; each cell is (source, tags)."""
    return {
        "nbformat": 4,
        "nbformat_minor": 4,
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        "cells": [
            {"cell_type": "code", "metadata": {"tags": list(tags)}, "source": src, "outputs": [], "execution_count": None}
            for src, tags in cells
        ],
    }


class ExecutorTest(unittest.TestCase):
    def run_executor(self, root, nb):
        (root / "data").mkdir()
        (root / "data" / "resources.json").write_text(json.dumps({"templates": [], "notebooks": []}))
        (root / "notebooks" / "technical").mkdir(parents=True)
        (root / "notebooks" / "technical" / "x.ipynb").write_text(json.dumps(nb))
        self.assertTrue(EXECUTOR.is_file(), f"the executor is not at {EXECUTOR}: set RUN_NOTEBOOKS_SCRIPT")
        return subprocess.run(
            [sys.executable, str(EXECUTOR), "--root", str(root), "--only", "x.ipynb", "--out", str(root / "out")],
            capture_output=True, text=True, timeout=300,
        )

    def test_executor_skips_optional_and_fails_on_error(self):
        # FR-SUG-07 NB-AC-01 NB-AC-08
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            ok = self.run_executor(root, notebook(("raise RuntimeError('optional cell ran')", ["optional"]), ("print(1)", ["method"])))
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            executed = json.loads((root / "out" / "x.ipynb").read_text())
            self.assertEqual(len(executed["cells"]), 1, "the optional cell must be removed from the executed copy")
            self.assertIsNotNone(executed["cells"][0]["execution_count"])
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            bad = self.run_executor(
                root,
                notebook(("raise RuntimeError('optional cell ran')", ["optional"]), ("print(1)", ["method"]), ("1 / 0", ["method"])),
            )
            self.assertEqual(bad.returncode, 1, bad.stdout + bad.stderr)


class EvidenceFixture(unittest.TestCase):
    """A control C-99 whose notebook imports numpy and pandas, with a data file of rows `age,Private,income`."""

    ROWS = 1500  # more than a thousand, so a check that stops early is caught

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.technical = self.root / "technical"
        self.evidence = self.technical / "evidence"
        self.evidence.mkdir(parents=True)
        self.data = self.root / "data.csv"
        self.write_data(self.data_lines())
        (self.technical / "C-99_demo.ipynb").write_text(
            json.dumps(
                notebook(
                    ('"""A docstring line:\nfrom the census extract"""', ["setup"]),
                    ("import numpy as np\nimport pandas as pd\nimport json", ["setup"]),
                    ("import not_a_package_xyz", ["optional"]),
                )
            )
        )
        self.write_summary()

    def data_lines(self):
        return ["age,workclass,income"] + [
            f"{20 + i % 60},Private{i},{'>50K' if i % 3 == 0 else '<=50K'}" for i in range(self.ROWS)
        ]

    def write_data(self, lines):
        self.data.write_text("\n".join(lines) + "\n")
        self.sha = hashlib.sha256(self.data.read_bytes()).hexdigest()

    def versions_block(self, names=("numpy", "pandas"), python=None):
        lines = [f"- Python {python or platform.python_version()}"]
        lines += [f"- {n} {importlib.metadata.version(n)}" for n in names]
        return "\n".join(lines)

    def write_summary(self, versions=None, sha=None, extra=""):
        sha = self.sha if sha is None else sha
        versions = self.versions_block() if versions is None else versions
        (self.evidence / "C-99_summary.md").write_text(
            f"# C-99 summary\n\nSelection rate by group: 0.31 and 0.12.\n\n## Packages\n{versions}\n\n## Data\nSHA-256 {sha}\n{extra}\n"
        )

    def check(self, *more_data):
        return subprocess.run(
            [sys.executable, str(CHECK), str(self.evidence), "C-99", str(self.data), *map(str, more_data)],
            capture_output=True, text=True, timeout=120,
        )

    def assertRefused(self, done, message):
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn(message, done.stderr)


class CheckEvidenceTest(EvidenceFixture):
    def test_check_evidence_accepts_a_clean_folder(self):
        # NB-AC-04
        (self.evidence / "table.csv").write_text("group,rate\nA,0.31\nB,0.12\n")
        (self.evidence / "plot.png").write_bytes(PNG_SIGNATURE + b"rest of an image")
        done = self.check()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_check_evidence_refuses_a_data_row(self):
        # NB-AC-04: the summary holds a full row of the data file
        self.write_summary(extra="Example person: 27,Private7,<=50K")
        self.assertRefused(self.check(), "C-99_summary.md holds a full row of the data")

    def test_check_evidence_refuses_a_data_row_in_a_csv(self):
        # NB-AC-04: any file, not only the summary
        (self.evidence / "sample.csv").write_text("a,b\n27,Private7,<=50K\n")
        self.assertRefused(self.check(), "sample.csv holds a full row of the data")

    def test_check_evidence_searches_every_row_not_the_first_thousand(self):
        # NB-AC-04: a row from far down the file
        (self.evidence / "late.csv").write_text("a,b\n" + self.data_lines()[1400] + "\n")
        self.assertRefused(self.check(), "late.csv holds a full row of the data")

    def test_check_evidence_sees_a_row_however_it_was_written_out(self):
        # NB-AC-04: pandas turns 27 into 27.0, to_string pads with spaces, quotes may wrap a field, a cleaner drops a full stop
        for name, text in {
            "float.csv": "age,w,i\n27.0,Private7,<=50K\n",
            "padded.md": "   age  workclass  income\n7   27  Private7   <=50K\n",
            "quoted.csv": 'age,w,i\n27,"Private7","<=50K"\n',
            "pipes.md": "| 27 | Private7 | <=50K |\n",
            "stopped.csv": "age,w,i\n27,Private7,<=50K.\n",
            "semicolon.csv": "age;w;i\n27;Private7;<=50K\n",
        }.items():
            with self.subTest(name):
                path = self.evidence / name
                path.write_text(text)
                self.assertRefused(self.check(), f"{name} holds a full row of the data")
                path.unlink()

    def test_check_evidence_refuses_a_file_it_cannot_search(self):
        # NB-AC-04: a compressed or structured file could hold every row
        (self.evidence / "all.csv.gz").write_bytes(b"\x1f\x8b")
        self.assertRefused(self.check(), "all.csv.gz: a .csv.gz file cannot be searched for rows")

    def test_check_evidence_does_not_pass_when_rows_are_too_short_to_search(self):
        # NB-AC-04: a two-field data file must not make the row check vacuous
        self.write_data(["id,score"] + [f"{i},0.{i}" for i in range(1, 60)])
        self.write_summary()
        (self.evidence / "copy.csv").write_text(self.data.read_text())
        self.assertRefused(self.check(), "copy.csv holds a full row of the data")

    def test_check_evidence_refuses_a_long_csv(self):
        # NB-AC-04: no CSV of more than 200 rows
        (self.evidence / "long.csv").write_text("n\n" + "\n".join(str(i) for i in range(201)) + "\n")
        self.assertRefused(self.check(), "long.csv has 201 data rows, more than 200")
        (self.evidence / "long.csv").write_text("n\n" + "\n".join(str(i) for i in range(200)) + "\n")
        self.assertEqual(self.check().returncode, 0)
        (self.evidence / "long.csv").write_text("\n".join(str(i) for i in range(201)) + "\n")  # no header line
        self.assertRefused(self.check(), "long.csv has 201 data rows, more than 200")

    def test_check_evidence_requires_versions_and_hash(self):
        # NB-AC-04
        self.write_summary(sha="0" * 64)
        self.assertRefused(self.check(), "does not hold the SHA-256 of data.csv")
        self.write_summary(versions=self.versions_block(("numpy",)))
        self.assertRefused(self.check(), "does not name pandas")
        wrong = self.versions_block().replace(importlib.metadata.version("pandas"), "0.0.1")
        self.write_summary(versions=wrong)
        done = self.check()
        self.assertRefused(done, "does not name pandas")
        self.assertNotIn("not_a_package_xyz", done.stderr, "an optional cell's import is not required")

    def test_check_evidence_requires_the_python_version(self):
        # NB-AC-04: a longer number that merely starts the same does not count
        self.write_summary(versions=self.versions_block(python=platform.python_version() + "0"))
        self.assertRefused(self.check(), f"does not name Python {platform.python_version()}")
        self.write_summary(versions=self.versions_block().replace("- Python", "- Snake"))
        self.assertRefused(self.check(), f"does not name Python {platform.python_version()}")

    def test_check_evidence_requires_exactly_one_notebook(self):
        # NB-AC-04: without the notebook the packages cannot be listed
        (self.technical / "C-99_demo.ipynb").unlink()
        self.assertRefused(self.check(), "expected one C-99_*.ipynb")

    def test_check_evidence_requires_the_summary_file_and_still_reports_the_rest(self):
        # NB-AC-04: the first problem does not hide the others
        (self.evidence / "C-99_summary.md").unlink()
        (self.evidence / "all.csv").write_text(self.data.read_text())
        done = self.check()
        self.assertRefused(done, "C-99_summary.md is missing or empty")
        self.assertIn("all.csv holds a full row of the data", done.stderr)

    def test_check_evidence_exit_codes_tell_misuse_and_breakage_from_refusal(self):
        # NB-AC-04: 2 for wrong use, never 0 for an unchecked folder
        misuse = subprocess.run([sys.executable, str(CHECK), str(self.evidence)], capture_output=True, text=True, timeout=120)
        self.assertEqual(misuse.returncode, 2)
        empty = self.root / "empty.csv"
        empty.write_text("id,score\n")
        refused = subprocess.run(
            [sys.executable, str(CHECK), str(self.evidence), "C-99", str(empty)], capture_output=True, text=True, timeout=120
        )
        self.assertEqual(refused.returncode, 1)
        self.assertIn("has no data row", refused.stderr)

    # --- fix round 1 -------------------------------------------------------------------------------------------

    def test_check_evidence_sees_a_row_with_missing_values_once_pandas_has_written_it_back(self):
        # NB-AC-04 (CR-1, SO-2): the data file holds the text NaN, None and ? in some fields. pandas reads the first two
        # as missing and writes them back as an empty field (to_csv) or as NaN (to_string); '?' is missing with na_values.
        import pandas as pd

        lines = ["id,race,weight,glu,A1C,gender,stay"] + [
            f"{1000 + i},Caucasian{i},NaN,None,None,Female,{i % 14 + 1}" for i in range(50)
        ] + [f"{2000 + i},Asian{i},?,None,>8,Male,{i % 14 + 1}" for i in range(50)]
        self.write_data(lines)
        self.write_summary()
        for na_values in (None, ["?"]):
            frame = pd.read_csv(self.data, na_values=na_values)
            row = frame.iloc[[7 if na_values is None else 60]]
            for name, text in {
                # With a header line, and without one (a header line alone is not a data row, N-4).
                "to_csv.csv": row.to_csv(index=False),
                "to_csv_noheader.csv": row.to_csv(index=False, header=False),
                "to_csv_index_noheader.csv": row.to_csv(header=False),
                "to_string.md": row.to_string(),
                "to_string_noheader.md": row.to_string(header=False),
                "to_string_noindex.md": row.to_string(index=False, header=False),
                "pipes.md": row.to_markdown(index=False) if hasattr(row, "to_markdown") and _has_tabulate() else row.to_csv(index=False, sep="|"),
                "pipes_noheader.md": row.to_csv(index=False, header=False, sep="|"),
                "tabs_noheader.csv": row.to_csv(index=False, header=False, sep="\t"),
                "na_dash_noheader.csv": row.to_csv(index=False, header=False, na_rep="-"),
                "na_slash_noheader.md": row.to_string(index=False, header=False, na_rep="n/a"),
                "na_upper_noheader.csv": row.to_csv(index=False, header=False, na_rep="N/A"),
            }.items():
                with self.subTest(name=name, na_values=na_values):
                    path = self.evidence / name
                    path.write_text(text)
                    self.assertRefused(self.check(), f"{name} holds a full row of the data")
                    path.unlink()

    def test_check_evidence_does_not_match_a_different_row_because_of_missing_markers(self):
        # NB-AC-04 (N-4): dropping '-' and 'n/a' must not make a row with another value match
        import pandas as pd

        self.write_data(["id,race,weight,glu,stay"] + [f"{1000 + i},Caucasian{i},NaN,None,{i % 14 + 1}" for i in range(50)])
        self.write_summary()
        row = pd.read_csv(self.data).iloc[[7]].copy()
        row["race"] = "Asian7"
        for na_rep in ("-", "n/a", ""):
            (self.evidence / "other.csv").write_text(row.to_csv(index=False, header=False, na_rep=na_rep))
            self.assertEqual(self.check().returncode, 0, f"na_rep {na_rep!r}")

    def test_check_evidence_does_not_flag_a_table_that_only_shares_missing_markers(self):
        # NB-AC-04: dropping missing markers must not make an ordinary table look like a data row
        (self.evidence / "counts.csv").write_text("group,missing,share\nA,NaN,0.31\nB,None,0.12\n")
        self.assertEqual(self.check().returncode, 0)

    def test_check_evidence_searches_every_data_file_and_needs_every_hash(self):
        # NB-AC-04 (SF-5): C-16 reads twelve files; a row of any of them is a data row, and every hash is named
        other = self.root / "other.tsv"
        other.write_text("t\tu\tv\n" + "\n".join(f"alpha{i}\tbeta{i}\tgamma{i}" for i in range(40)) + "\n")
        other_sha = hashlib.sha256(other.read_bytes()).hexdigest()
        done = self.check(other)
        self.assertRefused(done, f"does not hold the SHA-256 of other.tsv ({other_sha})")
        self.write_summary(extra=f"also {other_sha}")
        self.assertEqual(self.check(other).returncode, 0, "both hashes named, no row")
        (self.evidence / "leak.csv").write_text("a,b,c\nalpha7,beta7,gamma7\n")
        self.assertRefused(self.check(other), "leak.csv holds a full row of the data")
        self.assertEqual(self.check().returncode, 0, "the second file is not searched unless it is given")

    def test_check_evidence_refuses_text_saved_under_a_png_name(self):
        # NB-AC-04 (SF-3): a file it does not open must at least be an image
        (self.evidence / "rows.png").write_text(self.data.read_text())
        self.assertRefused(self.check(), "rows.png: not a PNG image")

    def test_check_evidence_refuses_a_link(self):
        # NB-AC-04 (SF-4): a linked folder is listed but not entered, so it cannot be checked
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "rows.csv").write_text(self.data.read_text())
        (self.evidence / "sub").symlink_to(outside, target_is_directory=True)
        self.assertRefused(self.check(), "sub: a link cannot be checked")

    def test_check_evidence_does_not_refuse_a_table_that_carries_the_dataset_header(self):
        # NB-AC-04 (N-3): the header line of the data file is not a data row. A column-count table, describe() of every
        # column and an empty head() all start with the header; a real row in the same folder is still refused.
        import pandas as pd

        lines = ["age,workclass,fnlwgt,education,income"] + [
            f"{20 + i % 40},Private,{100000 + i},Bachelors,{'>50K' if i % 3 == 0 else '<=50K'}" for i in range(60)
        ]
        self.write_data(lines)
        self.write_summary()
        frame = pd.read_csv(self.data)
        tables = {
            "describe.csv": frame.describe(include="all").to_csv(),
            "head0.csv": frame.head(0).to_csv(index=False),
            "missing_counts.csv": frame.isna().sum().to_frame().T.to_csv(index=False),
        }
        for name, text in tables.items():
            with self.subTest(name):
                (self.evidence / name).write_text(text)
        self.assertEqual(self.check().returncode, 0, self.check().stderr)
        (self.evidence / "row.csv").write_text(frame.iloc[[5]].to_csv(index=False))
        self.assertRefused(self.check(), "row.csv holds a full row of the data")


class EvidenceArchiveTest(EvidenceFixture):
    """The archive block each notebook's evidence-summary cell runs (D8): one ZIP beside the folder, with this control's own files only."""

    MAX_ZIP_BYTES = 10 * 1024 * 1024  # lib/evidence/inspect.ts accepts a ZIP up to 10 MiB

    def archive_blocks(self):
        """The archive step of the evidence-summary cell of each of the ten notebooks, as written.

        The rule: the step runs from the line that starts `Path('<C>_evidence.zip').unlink(` (removal of an earlier ZIP)
        to the line that starts `os.replace(` (the move of the .part file onto the final name), both included. The
        notebooks have exactly one of each, and nothing between them but the `with zipfile.ZipFile(` block.
        """
        blocks = {}
        for path in sorted((REPO / "notebooks" / "technical").glob("C-*.ipynb")):
            cells = [c for c in json.loads(path.read_text())["cells"] if "evidence-summary" in c["metadata"].get("tags", [])]
            self.assertEqual(len(cells), 1, f"{path.name}: one evidence-summary cell")
            lines = "".join(cells[0]["source"]).splitlines()
            starts = [i for i, ln in enumerate(lines) if ln.startswith("Path('") and "_evidence.zip').unlink(" in ln]
            ends = [i for i, ln in enumerate(lines) if ln.startswith("os.replace(")]
            self.assertEqual((len(starts), len(ends)), (1, 1), f"{path.name}: one removal and one move")
            self.assertLess(starts[0], ends[0])
            step = lines[starts[0]:ends[0] + 1]
            self.assertEqual(sum(ln.startswith("with zipfile.ZipFile(") for ln in step), 1, f"{path.name}: one zipfile block in the step")
            blocks[path.name[:4]] = "\n".join(step)
            self.assertNotIn("make_archive", "".join(cells[0]["source"]), f"{path.name}: no make_archive")
        self.assertEqual(len(blocks), 10)
        return blocks

    def run_block(self, block, fail_after=None):
        """Runs the archive step in the folder that holds `evidence/`. `fail_after=N` makes the (N+1)th member fail to be added."""
        prelude = "import os, zipfile\nfrom pathlib import Path\nEVIDENCE_DIR = Path('evidence')\n"
        if fail_after is not None:
            prelude += (
                "_write, _count = zipfile.ZipFile.write, [0]\n"
                "def _failing(self, *a, **k):\n"
                f"    if _count[0] >= {fail_after}: raise RuntimeError('disk full')\n"
                "    _count[0] += 1\n"
                "    return _write(self, *a, **k)\n"
                "zipfile.ZipFile.write = _failing\n"
            )
        # -I and a working folder of its own: the step writes its ZIP next to `evidence`, as it does in a notebook.
        return subprocess.run([sys.executable, "-I", "-c", prelude + block + "\n"], cwd=self.technical, capture_output=True, text=True, timeout=120)

    def members(self, archive):
        with zipfile.ZipFile(archive) as z:
            self.assertIsNone(z.testzip())
            return z.namelist()

    def test_the_zip_exists_starts_with_pk_is_small_and_the_folder_still_passes(self):
        # D8 NB-AC-04
        for control, block in self.archive_blocks().items():
            with self.subTest(control=control):
                own = {f"{control}_summary.md", f"{control}_table.csv", f"{control}_plot.png"}
                (self.evidence / f"{control}_summary.md").write_text((self.evidence / "C-99_summary.md").read_text())
                (self.evidence / f"{control}_table.csv").write_text("group,rate\nA,0.31\nB,0.12\n")
                (self.evidence / f"{control}_plot.png").write_bytes(PNG_SIGNATURE + b"rest of an image")
                done = self.run_block(block)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                archive = self.technical / f"{control}_evidence.zip"
                self.assertTrue(archive.is_file(), f"{archive.name} is written beside the evidence folder")
                self.assertFalse((self.evidence / archive.name).exists(), "the ZIP is not inside the evidence folder")
                self.assertEqual(archive.read_bytes()[:4], b"PK\x03\x04")
                self.assertLess(archive.stat().st_size, self.MAX_ZIP_BYTES)
                self.assertFalse((self.technical / f"{control}_evidence.zip.part").exists(), "the move leaves no .part file")
                self.assertEqual(self.members(archive), sorted(own), "this control's files, sorted, under bare names")
                # The folder is as before: the checker still accepts it (a ZIP inside it would be refused).
                done = self.check()
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                archive.unlink()
                for name in own:
                    (self.evidence / name).unlink()

    def test_the_zip_holds_only_this_controls_files_whatever_else_is_in_the_folder(self):
        # D8: notebooks run side by side share evidence/; another control's files, a stray file, a folder and a link stay out
        for control, block in self.archive_blocks().items():
            with self.subTest(control=control):
                own = {f"{control}_summary.md", f"{control}_table.csv", f"{control}_plot.png"}
                for name in own:
                    (self.evidence / name).write_bytes(b"own " + name.encode())
                others = {"C-77_summary.md", "C-77_table.csv", "C-77_plot.png", "notes.txt", f"{control}.csv", f"x{control}_table.csv", "C-1_table.csv"}
                for name in others:
                    (self.evidence / name).write_bytes(b"not this control's")
                (self.evidence / f"{control}_folder").mkdir()
                (self.evidence / f"{control}_folder" / f"{control}_inner.csv").write_text("a\n1\n")
                (self.evidence / f"{control}_link.csv").symlink_to(self.data)
                # A ZIP of the same name left by an earlier run is replaced, not added to.
                with zipfile.ZipFile(self.technical / f"{control}_evidence.zip", "w") as old:
                    old.writestr("stale_member.csv", "old")
                done = self.run_block(block)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(self.members(self.technical / f"{control}_evidence.zip"), sorted(own))
                with zipfile.ZipFile(self.technical / f"{control}_evidence.zip") as z:
                    for name in own:
                        self.assertEqual(z.read(name), b"own " + name.encode())
                (self.technical / f"{control}_evidence.zip").unlink()
                for name in own | others:
                    (self.evidence / name).unlink()
                (self.evidence / f"{control}_link.csv").unlink()
                (self.evidence / f"{control}_folder" / f"{control}_inner.csv").unlink()
                (self.evidence / f"{control}_folder").rmdir()


    def test_a_failure_while_adding_members_leaves_no_zip(self):
        # D8: complete or absent. The platform takes a ZIP by its first bytes, so a part-written one must never carry the final name.
        for control, block in self.archive_blocks().items():
            with self.subTest(control=control):
                for name in (f"{control}_summary.md", f"{control}_table.csv", f"{control}_plot.png"):
                    (self.evidence / name).write_bytes(b"own " + name.encode())
                final = self.technical / f"{control}_evidence.zip"
                with zipfile.ZipFile(final, "w") as earlier:
                    earlier.writestr(f"{control}_summary.md", "the previous run")
                done = self.run_block(block, fail_after=1)
                self.assertNotEqual(done.returncode, 0, "the step stops with an error")
                self.assertIn("disk full", done.stderr)
                self.assertFalse(final.exists(), "no ZIP carries the final name, and the previous run's ZIP is gone")
                part = self.technical / f"{control}_evidence.zip.part"
                self.assertFalse((self.evidence / part.name).exists(), "a leftover .part file is beside the folder, never in it")
                # What is left beside the folder is not zipped and does not disturb the checker.
                self.assertEqual(sorted(p.name for p in self.evidence.glob(f"{control}_*")), sorted([f"{control}_summary.md", f"{control}_table.csv", f"{control}_plot.png"]))
                # A later successful run replaces the leftover and leaves only the final ZIP.
                done = self.run_block(block)
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertTrue(final.is_file())
                self.assertFalse(part.exists(), "the move leaves no .part file")
                self.assertEqual(len(self.members(final)), 3)
                final.unlink()
                for name in (f"{control}_summary.md", f"{control}_table.csv", f"{control}_plot.png"):
                    (self.evidence / name).unlink()


class FetchCheckedTest(unittest.TestCase):
    """N2: each notebook's own fetch_checked stops on wrong bytes, from the cache or from the network (SO-3)."""

    TECHNICAL = REPO / "notebooks" / "technical"

    def sources(self):
        return sorted(self.TECHNICAL.glob("C-*.ipynb"))

    def helper_source(self, path):
        """The text of the helper pieces in the load-data cell: fetch_checked and the constants it reads."""
        nb = json.loads(path.read_text(encoding="utf-8"))
        cell = next(c for c in nb["cells"] if "load-data" in c["metadata"].get("tags", []))
        text = "".join(cell["source"])
        tree = ast.parse(text)
        wanted = [
            node for node in tree.body
            if (isinstance(node, ast.FunctionDef) and node.name == "fetch_checked")
            or (isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "MAX_DOWNLOAD_BYTES" for t in node.targets))
        ]
        return "\n\n".join(ast.get_source_segment(text, node) for node in wanted)

    def load(self, path, cache):
        # A stand-in for urllib, so a test replaces urlopen here and never in the real module.
        fake_urllib = types.SimpleNamespace(request=types.SimpleNamespace(Request=urllib.request.Request, urlopen=None))
        namespace = {"hashlib": hashlib, "urllib": fake_urllib, "os": os, "tempfile": tempfile, "Path": Path, "CACHE_DIR": cache}
        exec(compile(self.helper_source(path), str(path), "exec"), namespace)
        return namespace

    class Response:
        def __init__(self, body, url="https://example.org/x.csv"):
            self.body, self.url, self.at = body, url, 0

        def read(self, size=-1):
            size = len(self.body) - self.at if size is None or size < 0 else size
            block = self.body[self.at:self.at + size]
            self.at += len(block)
            return block

        def geturl(self):
            return self.url

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def test_the_ten_helpers_are_identical(self):
        bodies = {path.name: self.helper_source(path) for path in self.sources()}
        self.assertEqual(len(bodies), 10)
        self.assertEqual(len(set(bodies.values())), 1, "the ten fetch_checked copies have drifted apart")
        self.assertIn("MAX_DOWNLOAD_BYTES", next(iter(bodies.values())))

    def test_a_cache_file_with_the_wrong_bytes_stops_the_notebook(self):
        for path in self.sources():
            with self.subTest(path.name), tempfile.TemporaryDirectory() as tmp:
                cache = Path(tmp)
                (cache / "d.csv").write_bytes(b"tampered")
                fetch = self.load(path, cache)["fetch_checked"]
                with self.assertRaises(RuntimeError) as caught:
                    fetch("https://example.org/d.csv", hashlib.sha256(b"genuine").hexdigest(), "d.csv")
                self.assertIn("d.csv", str(caught.exception))
                self.assertEqual((cache / "d.csv").read_bytes(), b"tampered", "the cache file is left as it was")

    def test_a_download_with_the_wrong_bytes_is_not_kept(self):
        for path in self.sources():
            with self.subTest(path.name), tempfile.TemporaryDirectory() as tmp:
                cache = Path(tmp)
                namespace = self.load(path, cache)
                namespace["urllib"].request.urlopen = lambda request, timeout=None: self.Response(b"tampered")
                with self.assertRaises(RuntimeError):
                    namespace["fetch_checked"]("https://example.org/d.csv", hashlib.sha256(b"genuine").hexdigest(), "d.csv")
                self.assertEqual(list(cache.iterdir()), [], "nothing is kept: no file and no half-written file")

    def test_a_good_download_is_kept_and_then_checked_again(self):
        for path in self.sources():
            with self.subTest(path.name), tempfile.TemporaryDirectory() as tmp:
                cache = Path(tmp)
                namespace = self.load(path, cache)
                namespace["urllib"].request.urlopen = lambda request, timeout=None: self.Response(b"genuine")
                digest = hashlib.sha256(b"genuine").hexdigest()
                self.assertEqual(namespace["fetch_checked"]("https://example.org/d.csv", digest, "d.csv"), b"genuine")
                self.assertEqual([p.name for p in cache.iterdir()], ["d.csv"])
                self.assertEqual(namespace["fetch_checked"]("https://example.org/d.csv", digest, "d.csv"), b"genuine")

    def test_a_download_past_the_cap_is_refused_before_it_is_hashed_whole(self):
        for path in self.sources():
            with self.subTest(path.name), tempfile.TemporaryDirectory() as tmp:
                cache = Path(tmp)
                namespace = self.load(path, cache)
                cap = namespace["MAX_DOWNLOAD_BYTES"]
                body = b"\0" * (cap + 1)
                namespace["urllib"].request.urlopen = lambda request, timeout=None: self.Response(body)
                with self.assertRaises(RuntimeError) as caught:
                    namespace["fetch_checked"]("https://example.org/d.csv", hashlib.sha256(body).hexdigest(), "d.csv")
                self.assertIn("larger than", str(caught.exception))
                self.assertEqual(list(cache.iterdir()), [])

    def test_a_file_name_cannot_leave_the_cache_and_an_address_must_be_https(self):
        for path in self.sources():
            with self.subTest(path.name), tempfile.TemporaryDirectory() as tmp:
                fetch = self.load(path, Path(tmp))["fetch_checked"]
                with self.assertRaises(ValueError):
                    fetch("https://example.org/d.csv", "0" * 64, "../d.csv")
                with self.assertRaises(ValueError):
                    fetch("http://example.org/d.csv", "0" * 64, "d.csv")


def _has_tabulate():
    try:
        import tabulate  # noqa: F401
    except ImportError:
        return False
    return True


if __name__ == "__main__":
    unittest.main()
