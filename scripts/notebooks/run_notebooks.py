#!/usr/bin/env python3
"""The one notebook executor (FR-SUG-07, NB-AC-01, NB-AC-02, NB-AC-08).

    python3 scripts/notebooks/run_notebooks.py [--root DIR] [--check-only] [--only NAME] [--out DIR]

1. Reads <root>/data/resources.json. For each notebook entry with released: true, in file order, compares the SHA-256 of
   <root>/public + file with the entry's sha256 and exits 1, naming the file, on a mismatch or a missing file.
2. Unless --check-only, runs every <root>/notebooks/technical/*.ipynb in name order (only NAME with --only): cells tagged
   `optional` are removed, the rest run with nbclient with a 600 second timeout per cell. Any failure exits 1.
   --out DIR writes each executed copy to DIR/<file>; it never writes over notebooks/technical.

Standard library only until the execute path: nbclient and nbformat are imported there. The platform never runs this
on its host; it runs in CI (.github/workflows/notebooks.yml) and in C-NB's clean runs.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ONLY_NAME = re.compile(r"^[A-Za-z0-9._-]+\.ipynb$")
CELL_TIMEOUT_SECONDS = 600


def fail(message: str) -> "None":
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_released(root: Path) -> int:
    """Checks every released notebook's served copy against the resources file. Returns how many were released."""
    resources_path = root / "data" / "resources.json"
    if not resources_path.is_file():
        fail(f"{resources_path} does not exist")
    try:
        resources = json.loads(resources_path.read_text(encoding="utf8"))
        entries = resources["notebooks"]
    except (ValueError, KeyError, TypeError) as err:
        fail(f"{resources_path} is not a resources file: {err!r}")
    released = [n for n in entries if n.get("released") is True]
    for n in released:
        file = n.get("file")
        expected = n.get("sha256")
        if not isinstance(file, str) or not file.startswith("/notebooks/") or not isinstance(expected, str):
            fail(f"a released entry has no usable file or sha256: {n!r}")
        served = root / "public" / file.lstrip("/")
        if not served.is_file():
            fail(f"{file} is released but {served} does not exist")
        actual = sha256_of(served)
        if actual != expected:
            fail(f"{file} sha256 is {actual}, the resources file says {expected}")
        print(f"{file} sha256={actual} matches")
    return len(released)


def execute(source: Path, out_dir: "Path | None") -> None:
    import nbformat  # noqa: PLC0415 - only the execute path needs the locked environment
    from nbclient import NotebookClient  # noqa: PLC0415
    from nbclient.exceptions import CellExecutionError  # noqa: PLC0415

    print(f"{source.name} sha256={sha256_of(source)}")
    nb = nbformat.read(str(source), as_version=4)
    nb.cells = [c for c in nb.cells if "optional" not in c.get("metadata", {}).get("tags", [])]
    client = NotebookClient(
        nb, timeout=CELL_TIMEOUT_SECONDS, kernel_name="python3",
        resources={"metadata": {"path": str(source.parent)}},
    )
    try:
        client.execute()
    except CellExecutionError as err:
        fail(f"{source.name} failed: {err}")
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        nbformat.write(nb, str(out_dir / source.name))
    print("passed")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--out")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    technical = root / "notebooks" / "technical"

    # Refusals first, before any file is read or nbclient imported.
    if args.only is not None:
        if not ONLY_NAME.match(args.only):
            fail(f"--only {args.only!r} is not a notebook file name")
        if not (technical / args.only).is_file():
            fail(f"--only {args.only!r}: {technical / args.only} does not exist")
    out_dir = None
    if args.out is not None:
        out_dir = Path(args.out).resolve()
        if out_dir == technical.resolve():
            fail(f"--out {args.out!r} is the source folder; an executed copy never goes over a source")

    released = check_released(root)
    if args.only is not None:
        sources = [technical / args.only]
    else:
        sources = sorted(technical.glob("*.ipynb")) if technical.is_dir() else []
    print(f"{released} released notebooks, {len(sources)} sources")
    if args.check_only:
        return
    for source in sources:
        execute(source, out_dir)


if __name__ == "__main__":
    main()
