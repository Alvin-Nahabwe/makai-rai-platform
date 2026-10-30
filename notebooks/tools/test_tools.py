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
    """A control C-99 whose notebook imports numpy and pandas, with a 40-row data file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.technical = self.root / "technical"
        self.evidence = self.technical / "evidence"
        self.evidence.mkdir(parents=True)
        self.data = self.root / "data.csv"
        rows = ["age,workclass,income"] + [f"{20 + i},Private,{'>50K' if i % 3 == 0 else '<=50K'}" for i in range(40)]
        self.data.write_text("\n".join(rows) + "\n")
        self.sha = hashlib.sha256(self.data.read_bytes()).hexdigest()
        (self.technical / "C-99_demo.ipynb").write_text(
            json.dumps(notebook(("import numpy as np\nimport pandas as pd\nimport json", ["setup"]), ("import not_a_package_xyz", ["optional"])))
        )
        self.write_summary()

    def versions_block(self, names=("numpy", "pandas")):
        lines = [f"- Python {platform.python_version()}"]
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


class CheckEvidenceTest(EvidenceFixture):
    def test_check_evidence_accepts_a_clean_folder(self):
        # NB-AC-04
        (self.evidence / "table.csv").write_text("group,rate\nA,0.31\nB,0.12\n")
        done = self.check()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_check_evidence_refuses_a_data_row(self):
        # NB-AC-04: the summary holds a full row of the data file
        self.write_summary(extra="Example person: 27,Private,<=50K")
        done = self.check()
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("row", done.stderr)

    def test_check_evidence_refuses_a_data_row_in_a_csv(self):
        # NB-AC-04: any file, not only the summary
        (self.evidence / "sample.csv").write_text("a,b\n32,Private,>50K\n")
        done = self.check()
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("sample.csv", done.stderr)

    def test_check_evidence_refuses_a_long_csv(self):
        # NB-AC-04: no CSV of more than 200 rows
        (self.evidence / "long.csv").write_text("n\n" + "\n".join(str(i) for i in range(201)) + "\n")
        done = self.check()
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("long.csv", done.stderr)
        (self.evidence / "long.csv").write_text("n\n" + "\n".join(str(i) for i in range(200)) + "\n")
        self.assertEqual(self.check().returncode, 0)

    def test_check_evidence_requires_versions_and_hash(self):
        # NB-AC-04
        self.write_summary(sha="0" * 64)
        wrong_hash = self.check()
        self.assertEqual(wrong_hash.returncode, 1, wrong_hash.stdout + wrong_hash.stderr)
        self.assertIn("SHA-256", wrong_hash.stderr)
        self.write_summary(versions=self.versions_block(("numpy",)))
        missing_pkg = self.check()
        self.assertEqual(missing_pkg.returncode, 1, missing_pkg.stdout + missing_pkg.stderr)
        self.assertIn("pandas", missing_pkg.stderr)
        self.write_summary(versions=self.versions_block().replace(importlib.metadata.version("pandas"), "0.0.1"))
        wrong_version = self.check()
        self.assertEqual(wrong_version.returncode, 1, wrong_version.stdout + wrong_version.stderr)
        self.assertIn("pandas", wrong_version.stderr)
        self.assertNotIn("not_a_package_xyz", wrong_version.stderr, "an optional cell's import is not required")

    def test_check_evidence_requires_the_summary_file(self):
        # NB-AC-04
        (self.evidence / "C-99_summary.md").unlink()
        done = self.check()
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertIn("C-99_summary.md", done.stderr)


if __name__ == "__main__":
    unittest.main()
