#!/usr/bin/env python3
"""Check the evidence a notebook wrote before a team attaches it (NB-AC-04).

    python notebooks/tools/check_evidence.py <evidence-dir> <control-id> <data-file> [<data-file> ...]

Exit codes. 0: the folder is fit to attach. 1: it is not (every problem is printed to standard error, one per
line). 2: the command was used wrongly (wrong arguments, a folder or file that is not there, a bad control id):
nothing was checked. 3: the checker itself failed: the folder was NOT checked. The codes 2 and 3 are extra to the
brief's "exits 1 unless fit" so that a broken checker can be told from a refused folder; none of them is 0, so none
can be read as "fit". A problem is:

  * `<control-id>_summary.md` is missing or empty;
  * the summary does not hold the SHA-256 of every <data-file> (C-16 reads twelve files);
  * the summary does not name the Python version, or every package the notebook
    `<control-id>_*.ipynb` (beside the evidence folder) imports outside the standard
    library, optional cells excepted, each with its installed version;
  * a file in the evidence folder is not .md, .csv or .png, because a compressed or
    structured file cannot be searched for rows;
  * a file holds a full row of any <data-file>. Every data row is searched. Rows and files are
    both cut into tokens (split on spaces, commas, semicolons, tabs and pipes, quotes
    removed, numbers compared as numbers, a trailing full stop ignored, and the words pandas
    reads as missing values, or writes for them - empty, NaN, None, NA, n/a, <NA>, null, ? and
    a lone dash - dropped), so a row matches
    however the delimiter, the quoting, the number format or the missing-value text changed.
    A row of three or more tokens matches anywhere in a line; a shorter row matches only a
    whole line. The first line of a data file is taken for a header when it holds no number, and is
    not searched for: a table that carries the dataset's column names is not a data row. (So the first
    row of a headerless file made only of text is not searched; this is a registered risk);
  * a <data-file> yields no row to search for;
  * a file named .png does not begin with the PNG signature, or a link is in the folder
    (a linked folder is not entered, so it cannot be searched);
  * a .csv holds more than 200 data rows.

Nothing here is caught and ignored: a file that cannot be read is a problem, not a skip.
"""
import ast
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
from pathlib import Path

MAX_CSV_ROWS = 200
MIN_TOKENS_FOR_ANYWHERE = 3
ALLOWED_SUFFIXES = {".md", ".csv", ".png"}
TOKEN = re.compile(r"[^\s,;|\"']+")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# What pandas reads as missing (or writes back as missing). Dropped on both sides, so a row with a hole still matches.
MISSING = {"", "nan", "none", "na", "n/a", "<na>", "null", "?", "-"}
NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def normal_token(token):
    if NUMBER.fullmatch(token):
        return repr(float(token))
    return token[:-1] if len(token) > 1 and token.endswith(".") else token


def tokens(line):
    return tuple(normal_token(t) for t in TOKEN.findall(line) if t.lower() not in MISSING)


def looks_like_header(line):
    """A first line with no number in it names columns; one with a number is data."""
    return not any(NUMBER.fullmatch(t) for t in TOKEN.findall(line))


def data_rows(path):
    """Token tuples of every data row, as (windowed rows, whole-line-only rows, how many data rows)."""
    windowed, whole, rows = set(), set(), 0
    with path.open("r", encoding="utf-8", newline="") as handle:
        for number, line in enumerate(handle):
            if not line.strip():
                continue
            row = tokens(line)
            if not row:
                continue
            if number == 0 and looks_like_header(line):
                continue  # the header line names columns: it is not a data row, and a table that carries it is not refused
            else:
                rows += 1
                (windowed if len(row) >= MIN_TOKENS_FOR_ANYWHERE else whole).add(row)
    return windowed, whole, rows


def line_holds_a_row(line, windowed, whole):
    found = tokens(line)
    if found in whole:
        return True
    widths = {len(row) for row in windowed}
    for width in widths:
        if width > len(found):
            continue
        for start in range(len(found) - width + 1):
            if found[start:start + width] in windowed:
                return True
    return False


def imported_distributions(notebook_path):
    """Distributions of the non-standard-library modules imported by cells that CI runs."""
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    modules = set()
    for number, cell in enumerate(notebook["cells"]):
        if cell["cell_type"] != "code" or "optional" in cell["metadata"].get("tags", []):
            continue
        source = "".join(cell["source"]) if isinstance(cell["source"], list) else cell["source"]
        source = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith(("%", "!")))
        for node in ast.walk(ast.parse(source, filename=f"{notebook_path.name} cell {number}")):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
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


def version_is_named(summary, name, version):
    name = re.escape(name).replace(r"\-", r"[-_.]")
    pattern = rf"(?im)^[^\n]*\b{name}\b[^\n]*?(?<![\w.]){re.escape(version)}(?![\w.])"
    return re.search(pattern, summary) is not None


def check(evidence_dir, control, data_files):
    problems = []
    summary_path = evidence_dir / f"{control}_summary.md"
    summary = ""
    if not summary_path.is_file() or summary_path.stat().st_size == 0:
        problems.append(f"{summary_path.name} is missing or empty")
    else:
        try:
            summary = summary_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            problems.append(f"{summary_path.name} cannot be read: {error}")

    if summary:
        for data_file in data_files:
            data_sha = sha256_of(data_file)
            if data_sha not in summary:
                problems.append(f"{summary_path.name} does not hold the SHA-256 of {data_file.name} ({data_sha})")
        if not version_is_named(summary, "Python", platform.python_version()):
            problems.append(f"{summary_path.name} does not name Python {platform.python_version()}")
        notebooks = sorted(evidence_dir.parent.glob(f"{control}_*.ipynb"))
        if len(notebooks) != 1:
            problems.append(f"expected one {control}_*.ipynb beside {evidence_dir}, found {len(notebooks)}")
        else:
            try:
                needed = imported_distributions(notebooks[0])
            except (OSError, ValueError, SyntaxError, LookupError, KeyError) as error:
                problems.append(f"cannot list the packages {notebooks[0].name} imports: {error}")
                needed = set()
            for distribution in sorted(needed):
                version = importlib.metadata.version(distribution)
                if not version_is_named(summary, distribution, version):
                    problems.append(f"{summary_path.name} does not name {distribution} {version}")

    windowed, whole = set(), set()
    for data_file in data_files:
        try:
            more_windowed, more_whole, row_count = data_rows(data_file)
        except (OSError, UnicodeDecodeError) as error:
            problems.append(f"{data_file.name} cannot be read, so the evidence was not searched for rows: {error}")
            continue
        if row_count == 0:
            problems.append(f"{data_file.name} has no data row, so the evidence was not searched for rows")
        windowed |= more_windowed
        whole |= more_whole

    for path in sorted(evidence_dir.rglob("*")):
        relative = path.relative_to(evidence_dir)
        if path.is_symlink():
            problems.append(f"{relative}: a link cannot be checked; copy the file in instead")
            continue
        if not path.is_file():
            continue
        suffix = "".join(path.suffixes).lower()
        if suffix not in ALLOWED_SUFFIXES:
            problems.append(f"{relative}: a {suffix or 'no-suffix'} file cannot be searched for rows; remove it")
            continue
        if suffix == ".png":
            try:
                with path.open("rb") as handle:
                    signature = handle.read(len(PNG_SIGNATURE))
            except OSError as error:
                problems.append(f"{relative} cannot be read: {error}")
                continue
            if signature != PNG_SIGNATURE:
                problems.append(f"{relative}: not a PNG image, so it cannot be left unsearched")
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as error:
            problems.append(f"{relative} cannot be read: {error}")
            continue
        for line in lines:
            if line.strip() and line_holds_a_row(line, windowed, whole):
                problems.append(f"{relative} holds a full row of the data: {line.strip()[:40]}...")
                break
        if suffix == ".csv":
            body = [line for line in lines if line.strip()]
            rows = len(body) - (1 if body and looks_like_header(body[0]) else 0)
            if rows > MAX_CSV_ROWS:
                problems.append(f"{relative} has {rows} data rows, more than {MAX_CSV_ROWS}")
    return problems


def main(argv):
    if len(argv) < 4:
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    evidence_dir, control, data_files = Path(argv[1]), argv[2], [Path(a) for a in argv[3:]]
    if not evidence_dir.is_dir():
        print(f"{evidence_dir} is not a folder", file=sys.stderr)
        return 2
    for data_file in data_files:
        if not data_file.is_file():
            print(f"{data_file} is not a file", file=sys.stderr)
            return 2
    if not re.fullmatch(r"C-\d{2}", control):
        print(f"{control} is not a control id such as C-13", file=sys.stderr)
        return 2
    try:
        problems = check(evidence_dir, control, data_files)
    except Exception as error:  # the checker is broken: say so loudly and never report "fit"
        print(f"check_evidence.py failed itself ({type(error).__name__}: {error}); the folder was NOT checked", file=sys.stderr)
        return 3
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print(f"{control}: evidence folder is fit to attach")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
