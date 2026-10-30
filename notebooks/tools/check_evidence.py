#!/usr/bin/env python3
"""Check the evidence a notebook wrote before a team attaches it (NB-AC-04).

    python notebooks/tools/check_evidence.py <evidence-dir> <control-id> <data-file>

Exits 0 when the folder is fit to attach, 1 when it is not (every problem is printed to
standard error, one per line), 2 when the command is used wrongly. A problem is:

  * `<control-id>_summary.md` is missing or empty;
  * the summary does not hold the SHA-256 of <data-file>;
  * the summary does not name, with the installed version, every package the notebook
    `<control-id>_*.ipynb` (beside the evidence folder) imports outside the standard
    library, optional cells excepted, or does not name the Python version;
  * any file under the evidence folder holds a full row of <data-file> (its first 1,000
    data rows, fields joined by commas; the raw line, the tab-joined and the pipe-joined
    forms are searched too, and rows shorter than 12 characters are not, because a
    short row matches ordinary text);
  * any .csv under the evidence folder has more than 200 data rows.

Nothing here is caught and ignored: a file that cannot be read is a problem, not a skip.
"""
import csv
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
from pathlib import Path

MAX_CSV_ROWS = 200
ROWS_CHECKED = 1000
MIN_ROW_CHARS = 12


def normalise(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def data_rows(path):
    """The first ROWS_CHECKED data rows as the strings an evidence file could hold."""
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    forms = set()
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        next(reader, None)  # the header names columns; it is not a row of data
        for count, fields in enumerate(reader):
            if count >= ROWS_CHECKED:
                break
            for glue in (",", "\t", " | ", "|"):
                joined = glue.join(fields).strip()
                if len(joined) >= MIN_ROW_CHARS:
                    forms.add(joined)
    return forms


def imported_distributions(notebook_path):
    """Distributions of the non-standard-library modules imported by cells that CI runs."""
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    modules = set()
    for cell in notebook["cells"]:
        if cell["cell_type"] != "code" or "optional" in cell["metadata"].get("tags", []):
            continue
        source = "".join(cell["source"]) if isinstance(cell["source"], list) else cell["source"]
        for line in source.splitlines():
            from_import = re.match(r"\s*from\s+([A-Za-z_]\w*)", line)
            if from_import:
                modules.add(from_import.group(1))
                continue
            plain = re.match(r"\s*import\s+(.+)", line)
            if plain:
                modules.update(m.group(1) for m in re.finditer(r"(?:^|,)\s*([A-Za-z_]\w*)", plain.group(1)))
    owners = importlib.metadata.packages_distributions()
    distributions = set()
    for module in sorted(modules):
        if module in sys.stdlib_module_names:
            continue
        names = owners.get(module)
        if not names:
            raise LookupError(f"module {module} imported by {notebook_path.name} is not installed here")
        distributions.add(sorted(names)[0])
    return distributions


def version_is_named(summary, distribution, version):
    name = re.escape(distribution).replace(r"\-", r"[-_.]")
    pattern = rf"(?im)^[^\n]*\b{name}\b[^\n]*?\b{re.escape(version)}(?![\w.])"
    return re.search(pattern, summary) is not None


def check(evidence_dir, control, data_file):
    problems = []
    summary_path = evidence_dir / f"{control}_summary.md"
    if not summary_path.is_file() or summary_path.stat().st_size == 0:
        return [f"{summary_path} is missing or empty"]
    summary = summary_path.read_text(encoding="utf-8")

    data_sha = sha256_of(data_file)
    if data_sha not in summary:
        problems.append(f"{summary_path.name} does not hold the SHA-256 of {data_file.name} ({data_sha})")

    if platform.python_version() not in summary:
        problems.append(f"{summary_path.name} does not name the Python version {platform.python_version()}")
    notebooks = sorted(evidence_dir.parent.glob(f"{control}_*.ipynb"))
    if len(notebooks) != 1:
        problems.append(f"expected one {control}_*.ipynb beside {evidence_dir}, found {len(notebooks)}")
    else:
        for distribution in sorted(imported_distributions(notebooks[0])):
            version = importlib.metadata.version(distribution)
            if not version_is_named(summary, distribution, version):
                problems.append(f"{summary_path.name} does not name {distribution} {version}")

    rows = data_rows(data_file)
    for path in sorted(p for p in evidence_dir.rglob("*") if p.is_file()):
        raw = path.read_bytes()
        for row in rows:
            if row.encode("utf-8") in raw:
                problems.append(f"{path.relative_to(evidence_dir)} holds a full row of the data: {row[:40]}...")
                break
        if path.suffix.lower() == ".csv":
            lines = [line for line in raw.decode("utf-8").splitlines() if line.strip()]
            if len(lines) - 1 > MAX_CSV_ROWS:
                problems.append(f"{path.relative_to(evidence_dir)} has {len(lines) - 1} rows, more than {MAX_CSV_ROWS}")
    return problems


def main(argv):
    if len(argv) != 4:
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    evidence_dir, control, data_file = Path(argv[1]), argv[2], Path(argv[3])
    if not evidence_dir.is_dir():
        print(f"{evidence_dir} is not a folder", file=sys.stderr)
        return 2
    if not data_file.is_file():
        print(f"{data_file} is not a file", file=sys.stderr)
        return 2
    if not re.fullmatch(r"C-\d{2}", control):
        print(f"{control} is not a control id such as C-13", file=sys.stderr)
        return 2
    problems = check(evidence_dir, control, data_file)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(f"{control}: evidence folder is fit to attach")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
