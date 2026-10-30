"""Tests for the notebook tools (run with the locked environment's interpreter):

    RUN_NOTEBOOKS_SCRIPT=<path> notebooks/.venv/bin/python -m unittest notebooks/tools/test_tools.py

Three things are proved here:
  * the executor C-NB relies on (SUG's scripts/notebooks/run_notebooks.py) skips cells
    tagged `optional` and exits 1 when a cell that runs raises (NB-AC-08, NB-AC-01);
  * check_evidence.py refuses an evidence folder that holds a row of the data, a long
    CSV, or a summary without package versions and the data file's SHA-256 (NB-AC-04);
  * check_evidence.py accepts a folder that has none of those faults.
"""
import hashlib
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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

    def check(self):
        return subprocess.run(
            [sys.executable, str(CHECK), str(self.evidence), "C-99", str(self.data)],
            capture_output=True, text=True, timeout=120,
        )

    def assertRefused(self, done, message):
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn(message, done.stderr)


class CheckEvidenceTest(EvidenceFixture):
    def test_check_evidence_accepts_a_clean_folder(self):
        # NB-AC-04
        (self.evidence / "table.csv").write_text("group,rate\nA,0.31\nB,0.12\n")
        (self.evidence / "plot.png").write_bytes(b"\x89PNG\r\n")
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
        self.assertNotIn("the", done.stderr.split("pandas")[0].split()[-1:], "text in a string is not an import")

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
        misuse = subprocess.run([sys.executable, str(CHECK), str(self.evidence)], capture_output=True, text=True)
        self.assertEqual(misuse.returncode, 2)
        empty = self.root / "empty.csv"
        empty.write_text("id,score\n")
        refused = subprocess.run(
            [sys.executable, str(CHECK), str(self.evidence), "C-99", str(empty)], capture_output=True, text=True
        )
        self.assertEqual(refused.returncode, 1)
        self.assertIn("has no data row", refused.stderr)


if __name__ == "__main__":
    unittest.main()
