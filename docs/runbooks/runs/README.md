# Command run records

A command added to a covered runbook, or changed in one, is recorded here with the output of one run of
it, or marked "Not run" in the runbook. `docs/runbooks/command-runs.json` lists each such command by its
key and says which; `__tests__/lint/runbook-command-runs.test.ts` checks the list against the runbooks.
`node scripts/runbook-commands.mjs` prints every command block with its state, then every finding of the
test's check, and exits 1 if a block has no state or there is a finding (`--missing` prints only the blocks
that have none).

The covered files are `docs/runbooks/deployment.md`, `docs/runbooks/backup-restore.md`,
`docs/runbooks/troubleshooting.md` and `ops/host/README.md`.

## What counts as a command, and what is covered

- Only fenced blocks tagged `bash`, `sh`, `shell`, `zsh` or `console` (in any letter case) are read. A
  command in an untagged fence, a `text` fence, an indented code block or an inline code span is not seen,
  so every command goes in one of the five.
- A command file outside `docs/runbooks/` and `ops/host/README.md` is not covered. Under `docs/runbooks/`
  every file must be a covered runbook, `command-runs.json`, `command-runs.baseline.json` or a file under
  `runs/`; the test names any other file, at any depth and in any letter case, until it is covered or moved.
  A runbook's file name does not begin with a dot or end with `~`; such files are editor or system leftovers and are not read.

## Older commands

`command-runs.baseline.json` holds, for each command block that stood in the covered files on
13 November 2026 (commit `eac01ece`), its key and the number of times it occurs there. Those commands need
no record. An occurrence beyond that number, a copy of an older command anywhere in the covered files, is a
new command and needs an entry like any other. The check cannot tell the copy from the original, so it
reports the key once and names every occurrence. A block moved with no new occurrence still passes.

Marking a copied older command `not-run` needs the words "Not run" beneath every occurrence, the original
included.

## The record format

One file per command block, in this directory (any name except `README.md`). The registry entry names
it: `{ "status": "run", "record": "docs/runbooks/runs/<file>" }`.

```
Command block: 0123456789abcdef
Runbook: docs/runbooks/deployment.md
Run on: 2026-11-13 (UTC)
Where: rehearsal stack
Input: the 25 lines the rehearsal's web container logged, captured to a file
Exit: 0
Command:
<the block's text, verbatim>
Output:
<what it printed, at most 200 lines>
```

- Every header is required and not empty.
- `Command block` is the block's key: the first 16 hex characters of the SHA-256 of its text, after the
  common indentation and trailing whitespace are removed (`node scripts/runbook-commands.mjs` prints it).
- `Run on` is `YYYY-MM-DD (UTC)`.
- `Where` begins with one of three values: `rehearsal stack`, `build machine`, `CI run`.
- `Exit` is an integer.
- The text between `Command:` and `Output:` must hash to the `Command block` key.
- `Output` is at most 200 lines.

A command that was not run has no record. Its registry entry is
`{ "status": "not-run", "reason": "<why>" }`, and the line after each occurrence of the block in the
runbook begins `Not run`.

## Two cautions

- A record is public. Read it before it is committed. It holds no secret, address or personal detail.
- `Input` says what data the command read and where that data came from, so a reader can tell a run on
  real lines from a run on made-up ones.
