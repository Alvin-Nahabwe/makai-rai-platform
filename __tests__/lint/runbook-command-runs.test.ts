import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COVERED,
  blockKey,
  checkRunbookCommands,
  cliReport,
  countPlaceholders,
  extractCommandBlocks,
  parseRecord,
  unexpectedRunbookFiles,
} from '../../scripts/runbook-commands.mjs';

/**
 * NFR-MNT-06 / D-340: a command added to or changed in a runbook carries a recorded run beside it, or the words
 * "Not run" in the runbook. This file holds the rule (the real tree passes, the baseline is frozen, every runbook
 * is covered) and plants each kind of finding on small synthetic inputs, so the check is seen to fail.
 */

const read = (p: string) => readFileSync(p, 'utf8');

const realInputs = () => ({
  files: Object.fromEntries(COVERED.map((f: string) => [f, read(f)])),
  registry: JSON.parse(read('docs/runbooks/command-runs.json')),
  baseline: JSON.parse(read('docs/runbooks/command-runs.baseline.json')).keys as Record<string, number>,
  records: Object.fromEntries(
    readdirSync('docs/runbooks/runs')
      .filter((n) => n !== 'README.md')
      .map((n) => [`docs/runbooks/runs/${n}`, read(`docs/runbooks/runs/${n}`)]),
  ),
});

/** The SHA-256 of docs/runbooks/command-runs.baseline.json. Changes only with the owner's written word. */
const BASELINE_SHA256 = '05c01f32f4886673d2fbf02096220761d1fe1c7db292b5562bbed699a936edab';

/**
 * Placeholders (`<operator>` and the like) in each covered file's command blocks. These numbers may only go down:
 * each is the count of placeholders that predate the rule; filling them is register row D-363
 * (toolkit-process `docs/DEFERRED_REGISTER.md`).
 */
const PLACEHOLDERS: Record<string, number> = {
  'docs/runbooks/deployment.md': 73,
  'docs/runbooks/backup-restore.md': 13,
  'docs/runbooks/troubleshooting.md': 4,
  'ops/host/README.md': 48,
};

// ---- synthetic inputs --------------------------------------------------------------------------------------

const FILE = 'docs/runbooks/deployment.md';
const fence = (...lines: string[]) => ['```bash', ...lines, '```'].join('\n');
const doc = (...parts: string[]) => ['# T', '', 'First paragraph.', '', ...parts, ''].join('\n');
const check = (o: {
  text?: string;
  registry?: Record<string, { status?: string; record?: string; reason?: string }>;
  baseline?: string[]; // keys of the baseline, each frozen at one occurrence
  baselineCounts?: Record<string, number>; // or key -> frozen occurrence count
  records?: Record<string, string>;
  extra?: Record<string, string>;
}) =>
  checkRunbookCommands({
    files: { [FILE]: o.text ?? '', ...(o.extra ?? {}) },
    registry: { blocks: o.registry ?? {} },
    baseline: o.baselineCounts ?? Object.fromEntries((o.baseline ?? []).map((k) => [k, 1])),
    records: o.records ?? {},
  });
const recordFor = (cmd: string, over: Record<string, string | null> = {}, output = 'ok') => {
  const h: Record<string, string | null> = {
    'Command block': blockKey(cmd),
    Runbook: FILE,
    'Run on': '2026-11-13 (UTC)',
    Where: 'rehearsal stack',
    Input: 'made-up lines',
    Exit: '0',
    ...over,
  };
  const head = Object.entries(h)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return [...head, 'Command:', cmd, 'Output:', output].join('\n');
};
const REC = 'docs/runbooks/runs/a.txt';

/**
 * The files below docs/runbooks that git tracks, plus untracked ones that are not ignored: what a commit could
 * carry. Read from git, not from the directory, so a file an operating system or an editor leaves there and that
 * the repository ignores (`.DS_Store`) cannot turn the suite red. Run with an argument array; if git cannot be
 * run the case fails with the reason, with no fallback to the directory. `root` is the repository to list (the real
 * tree by default, which is only read: no case writes to or removes anything under the real docs/runbooks).
 */
function runbookFilesKnownToGit(root = process.cwd()): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'docs/runbooks'], { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`git ls-files could not be run: ${r.error?.message ?? r.stderr}`);
  return r.stdout.split('\0').filter((p) => p !== '');
}

describe('runbook command runs', () => {
  it('NFR-MNT-06 D-340: the covered runbooks pass the command-run check', () => {
    expect(checkRunbookCommands(realInputs())).toEqual([]);
  });

  it('NFR-MNT-06 D-340: the baseline file is frozen', () => {
    const sha = createHash('sha256').update(readFileSync('docs/runbooks/command-runs.baseline.json')).digest('hex');
    expect(sha).toBe(BASELINE_SHA256);
  });

  it('NFR-MNT-06 D-340: every file under docs/runbooks, at any depth, is a covered runbook, a data file or a record', () => {
    const found = runbookFilesKnownToGit();
    expect(found).toContain('docs/runbooks/deployment.md'); // the listing is not empty by accident
    expect(unexpectedRunbookFiles(found)).toEqual([]);
    expect(COVERED).toHaveLength(4);
  });

  it('NFR-MNT-06 D-340: in a temporary git repository, leftovers are listed but not reported, an ignored file is not listed, and a stray file is reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'runbook-listing-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.error || r.status !== 0) throw new Error(`git ${args[0]} could not be run: ${r.error?.message ?? r.stderr}`);
    };
    try {
      git('init', '-q');
      git('config', 'core.excludesFile', '/dev/null'); // a contributor's global ignore rules must not change the listing
      writeFileSync(join(root, '.gitignore'), '.DS_Store\n');
      mkdirSync(join(root, 'docs/runbooks'), { recursive: true });
      for (const f of ['deployment.md', '.deployment.md.swp', 'deployment.md~', '.DS_Store', 'notes.txt'])
        writeFileSync(join(root, 'docs/runbooks', f), 'x');
      const found = runbookFilesKnownToGit(root);
      expect(found.sort()).toEqual([
        'docs/runbooks/.deployment.md.swp',
        'docs/runbooks/deployment.md',
        'docs/runbooks/deployment.md~',
        'docs/runbooks/notes.txt',
      ]); // the ignored .DS_Store is not listed
      expect(unexpectedRunbookFiles(found)).toEqual(['docs/runbooks/notes.txt']); // deployment.md is a covered name
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NFR-MNT-06 D-340: no placeholder is added to a covered command block', () => {
    const counts = Object.fromEntries(COVERED.map((f: string) => [f, countPlaceholders(read(f), f)]));
    expect(counts).toEqual(PLACEHOLDERS);
  });

  describe('the planted cases', () => {
    it('NFR-MNT-06 D-340: placeholders are counted in command blocks only, and the exclusions hold', () => {
      const md = [
        'Prose with <operator> is not counted.',
        '```bash',
        'ssh <operator>@host <name> <a b>',
        'echo "<x>" <a|b> <$HOME> <a=b> <me@example.org> <<EOF',
        '```',
        '```text',
        '<other>',
        '```',
      ].join('\n');
      // counted: <operator>, <name>, <a b>, <x> (the quotes sit outside the capture); not counted: <a|b>, <$HOME>,
      // <a=b>, the email, the here-doc `<<EOF`, the prose line and the `text` fence.
      expect(countPlaceholders(md, FILE)).toBe(4);
    });

    it('NFR-MNT-06 D-340: each placeholder exclusion holds, and a plain token is still counted', () => {
      const excluded = ['<a;b>', '<a&b>', '<a(b)>', "<a'b>", '<a"b>', '<a`b>', 'cat <<EOF>f', '<a >'];
      for (const token of excluded) expect(countPlaceholders(fence(`echo ${token}`), FILE), token).toBe(0);
      expect(countPlaceholders(fence('echo <x>'), FILE)).toBe(1);
    });

    it('NFR-MNT-06 D-340: a new block with no entry is found with its file, line and key', () => {
      const cmd = 'echo new';
      const f = check({ text: doc(fence(cmd)) });
      expect(f).toHaveLength(1);
      expect(f[0]).toBe(`${FILE}:5  ${blockKey(cmd)}  a new or changed command has no run record and no "Not run" entry`);
    });

    it('NFR-MNT-06 D-340: a block changed by one character, with no entry, is found', () => {
      const old = 'echo old';
      const f = check({ text: doc(fence('echo olc')), baseline: [blockKey(old)] });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(`${FILE}:5`);
      expect(f[0]).toContain(blockKey('echo olc'));
      // the baseline key of the old text is now stale only if registered; unregistered, it raises nothing.
    });

    it('NFR-MNT-06 D-340: a run entry with no record is found', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({ text: doc(fence(cmd)), registry: { [k]: { status: 'run', record: REC } } });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(k);
      expect(f[0]).toContain(REC);
    });

    it('NFR-MNT-06 D-340: a run entry whose record is of other text is found', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({
        text: doc(fence(cmd)),
        registry: { [k]: { status: 'run', record: REC } },
        records: { [REC]: recordFor('echo b') },
      });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(k);
      expect(f[0]).toContain(REC);
    });

    it('NFR-MNT-06 D-340: a record missing Input is found', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({
        text: doc(fence(cmd)),
        registry: { [k]: { status: 'run', record: REC } },
        records: { [REC]: recordFor(cmd, { Input: null }) },
      });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(REC);
      expect(f[0]).toContain('Input');
    });

    it('NFR-MNT-06 D-340: a record with 201 output lines is found, and 200 passes', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const run = (n: number) =>
        check({
          text: doc(fence(cmd)),
          registry: { [k]: { status: 'run', record: REC } },
          records: { [REC]: recordFor(cmd, {}, Array.from({ length: n }, (_, i) => `l${i}`).join('\n')) },
        });
      expect(run(200)).toEqual([]);
      const f = run(201);
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(REC);
      expect(f[0]).toContain('200');
    });

    it('NFR-MNT-06 D-340: a not-run entry with no reason is found', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({
        text: doc(fence(cmd), 'Not run: reason.'),
        registry: { [k]: { status: 'not-run', reason: '  ' } },
      });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(k);
      expect(f[0]).toContain('reason');
    });

    it('NFR-MNT-06 D-340: a not-run entry where one of two occurrences lacks the Not run line is found at that line', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const text = doc(fence(cmd), 'Not run: reason.', '', fence(cmd), 'Something else.');
      const f = check({ text, registry: { [k]: { status: 'not-run', reason: 'why' } } });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(`${FILE}:10`);
      expect(f[0]).toContain(k);
    });

    it('NFR-MNT-06 D-340: an unknown status is found', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({ text: doc(fence(cmd)), registry: { [k]: { status: 'maybe' } } });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(k);
      expect(f[0]).toContain('maybe');
    });

    it('NFR-MNT-06 D-340: a registry key that no block has is found as stale', () => {
      const f = check({ text: doc(fence('echo a')), baseline: [blockKey('echo a')], registry: { deadbeefdeadbeef: { status: 'not-run', reason: 'x' } } });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain('deadbeefdeadbeef');
      expect(f[0]).toContain('stale');
    });

    it('NFR-MNT-06 D-340: a record file that no entry names is found', () => {
      const f = check({ text: doc(fence('echo a')), baseline: [blockKey('echo a')], records: { [REC]: recordFor('echo a') } });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(REC);
      expect(f[0]).toContain('no registry entry');
    });

    it('NFR-MNT-06 D-340: a re-indented block keeps its key, and trailing whitespace does not change it', () => {
      const plain = extractCommandBlocks(doc(fence('a', '  b')), FILE)[0];
      const indented = extractCommandBlocks(doc('  ```bash', '    a   ', '      b', '  ```'), FILE)[0];
      expect(indented.key).toBe(plain.key);
      expect(indented.text).toBe('a\n  b');
      expect(plain.line).toBe(5);
      expect(plain.endLine).toBe(8);
    });

    it('NFR-MNT-06 D-340: a baseline key with no entry passes, and may also carry a run', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      expect(check({ text: doc(fence(cmd)), baseline: [k] })).toEqual([]);
      expect(
        check({ text: doc(fence(cmd)), baseline: [k], registry: { [k]: { status: 'run', record: REC } }, records: { [REC]: recordFor(cmd) } }),
      ).toEqual([]);
      // ...and is then checked as an entry: a run with no record fails.
      expect(check({ text: doc(fence(cmd)), baseline: [k], registry: { [k]: { status: 'run', record: REC } } })).toHaveLength(1);
    });

    it('NFR-MNT-06 D-340: the fence reader takes longer and tilde fences and the tags the rule names, and no others', () => {
      const md = ['````sh', '```', 'inner', '```', '````', '~~~console', 'x', '~~~', '```json', 'y', '```', '```', 'z', '```'].join('\n');
      const b = extractCommandBlocks(md, FILE);
      expect(b.map((x) => x.text)).toEqual(['```\ninner\n```', 'x']);
      expect(b[0].after).toBe('~~~console');
      expect(b[1].after).toBe('```json');
    });

    it('NFR-MNT-06 D-340: a fence tag is read in any letter case', () => {
      for (const tag of ['Bash', 'BASH', 'shell', 'zsh', 'Sh', 'CONSOLE']) {
        const cmd = `echo ${tag}`;
        const f = check({ text: doc([`\`\`\`${tag}`, cmd, '```'].join('\n')) });
        expect(f, tag).toHaveLength(1);
        expect(f[0]).toContain(blockKey(cmd));
      }
    });

    it('NFR-MNT-06 D-340: a record whose Input header has no value is refused', () => {
      const r = parseRecord(recordFor('echo a', { Input: '' }));
      expect(r).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('Input');
    });

    it('NFR-MNT-06 D-340: an unclosed bash fence at the end of a file is read and found as a new command', () => {
      const cmd = 'rm -rf /srv/x';
      const f = check({ text: ['# T', '', '```bash', cmd].join('\n') });
      expect(f).toHaveLength(1);
      expect(f[0]).toBe(`${FILE}:3  ${blockKey(cmd)}  a new or changed command has no run record and no "Not run" entry`);
    });

    it('NFR-MNT-06 D-340: a not-run block is found when "Not run" is later in the next line, not at its start', () => {
      const cmd = 'echo a';
      const f = check({
        text: doc(fence(cmd), 'This was Not run'),
        registry: { [blockKey(cmd)]: { status: 'not-run', reason: 'why' } },
      });
      expect(f).toHaveLength(1);
      expect(f[0]).toContain(`${FILE}:5`);
    });

    it('NFR-MNT-06 D-340: a second copy of a baseline block in the same file is found at the copy', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({ text: doc(fence(cmd), '', fence(cmd)), baseline: [k] });
      expect(f).toEqual([
        `${FILE}:5  ${k}  occurs 2 times (${FILE}:5, ${FILE}:9); the baseline has 1: a copy of an older command has no run record and no "Not run" entry`,
      ]);
    });

    it('NFR-MNT-06 D-340: a copy of a baseline block in another covered file is found, in file order of COVERED', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const other = 'docs/runbooks/backup-restore.md';
      // the check cannot know which occurrence is the copy, so it names both, the first in the order of COVERED leading
      const f = check({ text: doc(fence(cmd)), extra: { [other]: doc(fence(cmd)) }, baseline: [k] });
      expect(f).toEqual([
        `${FILE}:5  ${k}  occurs 2 times (${FILE}:5, ${other}:5); the baseline has 1: a copy of an older command has no run record and no "Not run" entry`,
      ]);
    });

    it('NFR-MNT-06 D-340: the occurrences are listed in the order of COVERED, not the order the files are given in', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = checkRunbookCommands({
        files: { 'docs/runbooks/backup-restore.md': doc(fence(cmd)), [FILE]: doc(fence(cmd)) },
        registry: { blocks: {} },
        baseline: { [k]: 1 },
        records: {},
      });
      expect(f).toEqual([
        `${FILE}:5  ${k}  occurs 2 times (${FILE}:5, docs/runbooks/backup-restore.md:5); the baseline has 1: a copy of an older command has no run record and no "Not run" entry`,
      ]);
    });

    it('NFR-MNT-06 D-340: a baseline block moved with no new occurrence passes', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      expect(check({ text: doc(fence('echo b'), '', fence(cmd)), baseline: [k, blockKey('echo b')] })).toEqual([]);
      expect(check({ text: doc(fence(cmd)), baselineCounts: { [k]: 2 } })).toEqual([]);
    });

    it('NFR-MNT-06 D-340: a copy of a baseline block with a run entry and a good record passes', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const f = check({
        text: doc(fence(cmd), '', fence(cmd)),
        baseline: [k],
        registry: { [k]: { status: 'run', record: REC } },
        records: { [REC]: recordFor(cmd) },
      });
      expect(f).toEqual([]);
    });

    it('NFR-MNT-06 D-340: a file below docs/runbooks that is not a covered runbook, data file or record is reported with its path', () => {
      const listing = [
        'docs/runbooks/deployment.md',
        'docs/runbooks/backup-restore.md',
        'docs/runbooks/troubleshooting.md',
        'docs/runbooks/command-runs.json',
        'docs/runbooks/command-runs.baseline.json',
        'docs/runbooks/runs/README.md',
        'docs/runbooks/runs/a.txt',
        'docs/runbooks/sub/x.md',
        'docs/runbooks/X.MD',
        'docs/runbooks/x.markdown',
        'docs/runbooks/new.md',
      ];
      expect(unexpectedRunbookFiles(listing)).toEqual([
        'docs/runbooks/sub/x.md',
        'docs/runbooks/X.MD',
        'docs/runbooks/x.markdown',
        'docs/runbooks/new.md',
      ]);
    });

    it('NFR-MNT-06 D-340: editor and operating-system leftovers are not reported, and every other stray file is', () => {
      const listing = [
        'docs/runbooks/.deployment.md.swp',
        'docs/runbooks/deployment.md~',
        'docs/runbooks/sub/.DS_Store',
        'docs/runbooks/notes.txt',
        'docs/runbooks/sub/x.md',
        'docs/runbooks/X.MD',
      ];
      expect(unexpectedRunbookFiles(listing)).toEqual(['docs/runbooks/notes.txt', 'docs/runbooks/sub/x.md', 'docs/runbooks/X.MD']);
    });

    it('NFR-MNT-06 D-340: a stray file inside a dot-named directory is reported, because the dot rule is about the base name only', () => {
      expect(unexpectedRunbookFiles(['docs/runbooks/.sub/x.md', 'docs/runbooks/.sub/.hidden'])).toEqual(['docs/runbooks/.sub/x.md']);
    });

    it('NFR-MNT-06 D-340: the CLI given --root with no directory exits non-zero and says what it needs', () => {
      const r = spawnSync(process.execPath, ['scripts/runbook-commands.mjs', '--root'], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('--root needs a directory');
    });

    it('NFR-MNT-06 D-340: the CLI report prints the findings after the block lines and exits 1, also when no block is missing', () => {
      const cmd = 'echo a';
      const k = blockKey(cmd);
      const input = {
        files: { [FILE]: doc(fence(cmd)) },
        registry: { blocks: { [k]: { status: 'run', record: REC } } },
        baseline: { [k]: 1 },
        records: {},
      };
      const r = cliReport(input, false);
      expect(r.code).toBe(1);
      expect(r.lines[0]).toBe(`${k}  ${FILE}:5  run  echo a`);
      expect(r.lines.slice(1).join('\n')).toContain(REC);
      const ok = cliReport({ ...input, registry: { blocks: {} } }, false);
      expect(ok).toEqual({ lines: [`${k}  ${FILE}:5  baseline  echo a`], code: 0 });
      const missing = cliReport({ ...input, registry: { blocks: {} }, baseline: {} }, true);
      expect(missing.code).toBe(1);
      expect(missing.lines).toEqual([`${k}  ${FILE}:5  MISSING  echo a`, expect.stringContaining(k)]);
    });

    it('NFR-MNT-06 D-340: the CLI run as a process on another root exits 1 and prints the finding for a stale registry key', () => {
      const root = mkdtempSync(join(tmpdir(), 'runbook-commands-'));
      try {
        mkdirSync(join(root, 'docs/runbooks/runs'), { recursive: true });
        mkdirSync(join(root, 'ops/host'), { recursive: true });
        for (const f of [...COVERED, 'docs/runbooks/command-runs.baseline.json']) copyFileSync(f, join(root, f));
        writeFileSync(join(root, 'docs/runbooks/command-runs.json'), JSON.stringify({ blocks: { deadbeefdeadbeef: { status: 'not-run', reason: 'x' } } }));
        const r = spawnSync(process.execPath, [join(process.cwd(), 'scripts/runbook-commands.mjs'), '--root', root], { encoding: 'utf8' });
        expect(r.status).toBe(1);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines).toHaveLength(183);
        expect(lines[182]).toBe('docs/runbooks/command-runs.json  deadbeefdeadbeef  stale entry: no command block in the covered files has this key');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('NFR-MNT-06 D-340: the CLI run as a process on the real tree prints one line per block and exits 0', () => {
      const r = spawnSync(process.execPath, ['scripts/runbook-commands.mjs'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.trimEnd().split('\n')).toHaveLength(182);
    });

    it('NFR-MNT-06 D-340: parseRecord accepts a well-formed record and refuses a bad date, place or exit', () => {
      const cmd = 'echo a';
      expect(parseRecord(recordFor(cmd))).not.toHaveProperty('error');
      expect(parseRecord(recordFor(cmd, { 'Run on': '13 Nov 2026' }))).toHaveProperty('error');
      expect(parseRecord(recordFor(cmd, { Where: 'my laptop' }))).toHaveProperty('error');
      expect(parseRecord(recordFor(cmd, { Exit: 'zero' }))).toHaveProperty('error');
    });
  });
});
