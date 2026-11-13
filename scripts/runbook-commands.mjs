// Runbook commands show a run (NFR-MNT-06, register row D-340).
//
// A command added to or changed in a covered runbook carries the record of one run beside it in the commit, or the
// words "Not run" beneath it in the runbook. This module holds the one implementation: the extraction of command
// blocks, their keys, the placeholder count, the record parser and the check. The test is
// `__tests__/lint/runbook-command-runs.test.ts`. The CLI (`node scripts/runbook-commands.mjs [--missing]`) runs only
// when this file is the entry point.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The files the rule covers. A new `docs/runbooks/*.md` must be added here; the test fails until it is. */
export const COVERED = [
  'docs/runbooks/deployment.md',
  'docs/runbooks/backup-restore.md',
  'docs/runbooks/troubleshooting.md',
  'ops/host/README.md',
];

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNS_DIR = 'docs/runbooks/runs';
const REGISTRY = 'docs/runbooks/command-runs.json';
const BASELINE = 'docs/runbooks/command-runs.baseline.json';
const COMMAND_TAGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);
const MAX_OUTPUT_LINES = 200;
const WHERE_VALUES = ['rehearsal stack', 'build machine', 'CI run'];
const HEADERS = ['Command block', 'Runbook', 'Run on', 'Where', 'Input', 'Exit'];

/**
 * @typedef {{ file: string, line: number, endLine: number, text: string, key: string, after: string }} Block
 * @typedef {{ status?: string, record?: string, reason?: string }} Entry
 * @typedef {{ headers: Record<string, string>, command: string, output: string[], key: string }} RunRecord
 */

/**
 * The first 16 hex characters of the SHA-256 of `text` (UTF-8).
 * @param {string} text
 * @returns {string}
 */
export function blockKey(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Every fenced block tagged as a command (`bash`, `sh`, `shell`, `zsh`, `console`, in any letter case). Fences of
 * other tags are read too, so that a command fence quoted inside one does not open a block.
 * @param {string} markdown
 * @param {string} file
 * @returns {Block[]}
 */
export function extractCommandBlocks(markdown, file) {
  const lines = markdown.split('\n');
  /** @type {Block[]} */
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) continue;
    const ch = open[1][0];
    const len = open[1].length;
    const closer = new RegExp(`^\\s*${ch === '`' ? '`' : '~'}{${len},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !closer.test(lines[end])) end++;
    // `end` is the closing fence's index, or lines.length when the fence never closes (the block runs to the end).
    if (COMMAND_TAGS.has(open[2].toLowerCase())) {
      const body = lines.slice(i + 1, end);
      const indents = body.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
      const strip = indents.length ? Math.min(...indents) : 0;
      const text = body.map((l) => l.slice(strip).replace(/\s+$/, '')).join('\n');
      const after = lines.slice(end + 1).find((l) => l.trim() !== '');
      blocks.push({
        file,
        line: i + 1,
        endLine: Math.min(end, lines.length - 1) + 1,
        text,
        key: blockKey(text),
        after: after === undefined ? '' : after.trim(),
      });
    }
    i = end;
  }
  return blocks;
}

/**
 * The number of placeholders (`<operator>` and the like) in command block lines. The pattern is duplicated on
 * purpose in the process repository's own checker (`toolkit-process/scripts/claims/lib/steps.mjs`): the two
 * repositories share no code.
 * @param {string} markdown
 * @param {string} file
 * @returns {number}
 */
export function countPlaceholders(markdown, file) {
  const pattern = /(?<!<)<([A-Za-z0-9](?:[^<>\n]*[^<>\n ])?)>/g;
  let n = 0;
  for (const block of extractCommandBlocks(markdown, file))
    for (const line of block.text.split('\n'))
      for (const m of line.matchAll(pattern)) {
        if (/[()|&;$"'=`]/.test(m[1])) continue;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m[1])) continue;
        n++;
      }
  return n;
}

/**
 * Parse a record file.
 * @param {string} text
 * @returns {RunRecord | { error: string }}
 */
export function parseRecord(text) {
  const lines = text.split('\n');
  const cmdAt = lines.indexOf('Command:');
  if (cmdAt === -1) return { error: 'missing "Command:" line' };
  const outAt = lines.indexOf('Output:', cmdAt + 1);
  if (outAt === -1) return { error: 'missing "Output:" line' };
  /** @type {Record<string, string>} */
  const headers = {};
  for (const l of lines.slice(0, cmdAt)) {
    const m = /^([A-Za-z ]+): ?(.*)$/.exec(l);
    if (m && HEADERS.includes(m[1])) headers[m[1]] = m[2].trim();
  }
  for (const h of HEADERS) if (!headers[h]) return { error: `missing or empty header "${h}"` };
  if (!/^\d{4}-\d{2}-\d{2} \(UTC\)$/.test(headers['Run on'])) return { error: '"Run on" is not YYYY-MM-DD (UTC)' };
  if (!WHERE_VALUES.some((w) => headers.Where.startsWith(w))) return { error: `"Where" does not begin with one of: ${WHERE_VALUES.join(', ')}` };
  if (!/^-?\d+$/.test(headers.Exit)) return { error: '"Exit" is not an integer' };
  const command = lines.slice(cmdAt + 1, outAt).join('\n');
  const key = blockKey(command);
  if (key !== headers['Command block']) return { error: `the command text hashes to ${key}, not to the "Command block" key ${headers['Command block']}` };
  const output = lines.slice(outAt + 1);
  if (output.length && output[output.length - 1] === '') output.pop(); // the file's final newline is not an output line
  if (output.length > MAX_OUTPUT_LINES) return { error: `output has ${output.length} lines, at most ${MAX_OUTPUT_LINES}` };
  return { headers, command, output, key };
}

/**
 * The files below `docs/runbooks/` (at any depth) that are neither a covered runbook, one of the two data files nor a
 * record under `runs/`, leaving aside editor and operating-system leftovers. A new runbook, or a runbook in a
 * subdirectory or with another letter case, is reported with its path until it is covered.
 * @param {string[]} paths repository-relative paths with `/` separators, files only
 * @returns {string[]}
 */
export function unexpectedRunbookFiles(paths) {
  const allowed = new Set([...COVERED, REGISTRY, BASELINE]);
  // A base name that begins with a dot or ends with `~` is an editor or operating-system leftover (`.DS_Store`, a vim
  // swap file, a backup copy), never a runbook, and is not read.
  const leftover = (/** @type {string} */ p) => /^\.|~$/.test(p.slice(p.lastIndexOf('/') + 1));
  return paths.filter((p) => !allowed.has(p) && !p.startsWith(`${RUNS_DIR}/`) && !leftover(p));
}

/**
 * The blocks of all files, in the order of `COVERED` (a file that is not covered comes after, in the order given),
 * then by line.
 * @param {Record<string, string>} files
 * @returns {Block[]}
 */
function orderedBlocks(files) {
  const rank = (/** @type {string} */ f) => (COVERED.includes(f) ? COVERED.indexOf(f) : COVERED.length);
  return Object.entries(files)
    .sort(([a], [b]) => rank(a) - rank(b))
    .flatMap(([file, md]) => extractCommandBlocks(md, file));
}

/**
 * Which occurrences of the baseline are used up: the first `baseline[key]` occurrences of a key, in file order of
 * `COVERED`, then line, are the old ones; any later one is a copy.
 * @param {Block[]} blocks
 * @param {Record<string, number>} baseline
 * @returns {Map<Block, boolean>} true for a copy of an older command, false for the first occurrences of a baseline key
 */
function copiesOfBaseline(blocks, baseline) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Map<Block, boolean>} */
  const isCopy = new Map();
  for (const b of blocks) {
    const n = (seen.get(b.key) ?? 0) + 1;
    seen.set(b.key, n);
    isCopy.set(b, n > (baseline[b.key] ?? 0));
  }
  return isCopy;
}

/**
 * Check the covered files against the registry, the baseline and the records.
 * `baseline` maps each key frozen at eac01ece to the number of its occurrences then. A block whose key is not in
 * the baseline, or an occurrence beyond that number, needs a registry entry; a block moved with no new occurrence
 * does not.
 * @param {{ files: Record<string, string>, registry: { blocks: Record<string, Entry> }, baseline: Record<string, number>, records: Record<string, string> }} input
 * @returns {string[]} findings; empty means pass
 */
export function checkRunbookCommands({ files, registry, baseline, records }) {
  /** @type {string[]} */
  const findings = [];
  const blocks = orderedBlocks(files);
  /** @type {Map<string, Block[]>} */
  const byKey = new Map();
  for (const b of blocks) byKey.set(b.key, [...(byKey.get(b.key) ?? []), b]);

  // A key the baseline does not hold: each occurrence is new. A key it holds, found more often than it was frozen:
  // the check cannot tell the copy from the original (a copy may sit before it), so it names every occurrence, once.
  for (const [key, occurrences] of byKey) {
    if (key in registry.blocks) continue;
    if (!(key in baseline)) {
      for (const b of occurrences) findings.push(`${b.file}:${b.line}  ${key}  a new or changed command has no run record and no "Not run" entry`);
    } else if (occurrences.length > baseline[key]) {
      const where = occurrences.map((b) => `${b.file}:${b.line}`);
      findings.push(
        `${where[0]}  ${key}  occurs ${occurrences.length} times (${where.join(', ')}); the baseline has ${baseline[key]}: a copy of an older command has no run record and no "Not run" entry`,
      );
    }
  }

  const named = new Set();
  for (const [key, entry] of Object.entries(registry.blocks)) {
    const occurrences = byKey.get(key) ?? [];
    if (!occurrences.length) findings.push(`${REGISTRY}  ${key}  stale entry: no command block in the covered files has this key`);
    if (entry.status === 'run') {
      const rec = entry.record ?? '';
      named.add(rec);
      if (!(rec in records)) findings.push(`${REGISTRY}  ${key}  run entry: record ${rec || '(none named)'} is not among the files under ${RUNS_DIR}/`);
      else {
        const parsed = parseRecord(records[rec]);
        if ('error' in parsed) findings.push(`${rec}  ${key}  record does not parse: ${parsed.error}`);
        else if (parsed.key !== key) findings.push(`${rec}  ${key}  record is of block ${parsed.key}, not of this key`);
      }
    } else if (entry.status === 'not-run') {
      if (!(entry.reason ?? '').trim()) findings.push(`${REGISTRY}  ${key}  not-run entry has an empty reason`);
      for (const b of occurrences)
        if (!b.after.startsWith('Not run')) findings.push(`${b.file}:${b.line}  ${key}  not-run entry, but the line after the block does not begin "Not run"`);
    } else findings.push(`${REGISTRY}  ${key}  unknown status "${entry.status}" (expected "run" or "not-run")`);
  }

  for (const rec of Object.keys(records))
    if (!named.has(rec)) findings.push(`${rec}  no registry entry names this record file`);
  return findings;
}

/**
 * What the CLI prints and its exit code: one line per command block, `KEY  FILE:LINE  STATE  FIRST LINE`, then the
 * findings of `checkRunbookCommands`. `STATE` is `baseline`, `run`, `not-run` or `MISSING` (an occurrence with no
 * entry beyond what the baseline holds, or an entry with another status). The code is 1 on any finding or any
 * `MISSING` block.
 * @param {{ files: Record<string, string>, registry: { blocks: Record<string, Entry> }, baseline: Record<string, number>, records: Record<string, string> }} input
 * @param {boolean} onlyMissing print only the `MISSING` block lines
 * @returns {{ lines: string[], code: number }}
 */
export function cliReport(input, onlyMissing) {
  const blocks = orderedBlocks(input.files);
  const isCopy = copiesOfBaseline(blocks, input.baseline);
  const lines = [];
  let missing = 0;
  for (const b of blocks) {
    const status = input.registry.blocks[b.key]?.status;
    const state = status === 'run' || status === 'not-run' ? status : isCopy.get(b) ? 'MISSING' : 'baseline';
    if (state === 'MISSING') missing++;
    if (onlyMissing && state !== 'MISSING') continue;
    lines.push(`${b.key}  ${b.file}:${b.line}  ${state}  ${b.text.split('\n')[0]}`);
  }
  const findings = checkRunbookCommands(input);
  return { lines: [...lines, ...findings], code: missing || findings.length ? 1 : 0 };
}

/**
 * The CLI: reads the covered files, the registry, the baseline and the records from the repository root, or from the
 * directory named by `--root DIR`. Returns the exit code.
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const at = argv.indexOf('--root');
  if (at !== -1 && !argv[at + 1]) throw new Error('--root needs a directory');
  const root = at === -1 ? REPO_ROOT : argv[at + 1];
  const read = (/** @type {string} */ p) => readFileSync(join(root, p), 'utf8');
  const records = Object.fromEntries(
    readdirSync(join(root, RUNS_DIR))
      .filter((n) => n !== 'README.md')
      .map((n) => [`${RUNS_DIR}/${n}`, read(`${RUNS_DIR}/${n}`)]),
  );
  const { lines, code } = cliReport(
    {
      files: Object.fromEntries(COVERED.map((f) => [f, read(f)])),
      registry: JSON.parse(read(REGISTRY)),
      baseline: JSON.parse(read(BASELINE)).keys,
      records,
    },
    argv.includes('--missing'),
  );
  for (const line of lines) console.log(line);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
