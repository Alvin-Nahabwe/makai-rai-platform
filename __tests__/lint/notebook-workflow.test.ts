import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

/**
 * The notebook job (FR-SUG-07): a separate, read-only, pinned workflow, and the one executor that checks the released
 * copies' SHA-256 and runs every notebook source. Execution itself needs nbclient, which this host does not have;
 * the refusals tested here all come before nbclient is imported.
 */
const PATHS = ['notebooks/**', 'public/notebooks/**', 'data/resources.json', 'scripts/notebooks/**', '.github/workflows/notebooks.yml'];
const SCRIPT = 'scripts/notebooks/run_notebooks.py';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function tempRoot(o: { released: Array<{ file: string; bytes: string; source?: string | false }>; releasedFlag?: unknown }): string {
  const root = mkdtempSync(join(tmpdir(), 'nbjob-'));
  roots.push(root);
  const notebooks = o.released.map((n) => {
    const path = join(root, 'public', n.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, n.bytes);
    if (n.source !== false) {
      mkdirSync(join(root, 'notebooks/technical'), { recursive: true });
      writeFileSync(join(root, 'notebooks/technical', n.file.split('/').pop()!), n.source ?? n.bytes);
    }
    return {
      controlId: 'C-13', file: n.file, requirementsFile: '/notebooks/requirements.txt', bytes: n.bytes.length,
      sha256: createHash('sha256').update(n.bytes).digest('hex'),
      review: { reviewer: 'r', date: '2026-10-31', outcome: 'passed' }, released: o.releasedFlag ?? true,
    };
  });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/resources.json'), JSON.stringify({ templates: [], notebooks }));
  return root;
}
// The child's output is matched, so it gets NO_COLOR and no FORCE_COLOR, and the match strips ANSI (CI colours its children).
const ansi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const py = (args: string[]) => {
  const { FORCE_COLOR: _drop, ...env } = process.env;
  const r = spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
  return { status: r.status, stdout: ansi(r.stdout), stderr: ansi(r.stderr) };
};
const run = (root: string) => py(['--root', root, '--check-only']);

describe('notebook workflow and executor', () => {
  it('FR-SUG-07: the notebook workflow is separate, pinned, read-only and never self-hosted', () => {
    const text = readFileSync('.github/workflows/notebooks.yml', 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed workflow file
    const wf = loadYaml(text) as any;
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const ev of ['push', 'pull_request']) expect(wf.on[ev].paths).toEqual(PATHS);
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(Object.keys(wf.jobs)).toEqual(['run-notebooks']);
    expect(wf.jobs['run-notebooks']['runs-on']).toBe('ubuntu-24.04');
    expect(text).not.toMatch(/secrets\.|self-hosted|setup-python/);
    expect(text).toContain('pip install --require-hashes --no-deps -r notebooks/requirements.txt');
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).not.toContain('run_notebooks.py');
  });

  it('FR-SUG-07: the hash check refuses a changed notebook and passes an unchanged one', () => {
    const root = tempRoot({ released: [{ file: '/notebooks/C-13_x.ipynb', bytes: '{"cells":[]}' }] });
    expect(run(root).status).toBe(0);
    writeFileSync(join(root, 'public/notebooks/C-13_x.ipynb'), '{"cells":[1]}');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('/notebooks/C-13_x.ipynb');
  });

  it('FR-SUG-07: a released notebook whose file is missing fails and names it', () => {
    const root = tempRoot({ released: [{ file: '/notebooks/C-13_x.ipynb', bytes: '{}' }] });
    rmSync(join(root, 'public/notebooks/C-13_x.ipynb'));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('/notebooks/C-13_x.ipynb');
  });

  it('FR-SUG-07: a released notebook with no source, or with a source that differs, fails and names the file', () => {
    const none = run(tempRoot({ released: [{ file: '/notebooks/C-13_x.ipynb', bytes: '{"cells":[]}', source: false }] }));
    expect(none.status).toBe(1);
    expect(none.stdout + none.stderr).toContain('/notebooks/C-13_x.ipynb');
    expect(none.stdout + none.stderr).toContain('no source');
    const differs = run(tempRoot({ released: [{ file: '/notebooks/C-13_x.ipynb', bytes: '{"cells":[]}', source: '{"cells":[1]}' }] }));
    expect(differs.status).toBe(1);
    expect(differs.stdout + differs.stderr).toContain('differs from the released copy');
  });

  it('FR-SUG-07 NFR-SEC-11: a released flag that is not true or false, or a file outside the notebook pattern, fails', () => {
    const flag = run(tempRoot({ released: [{ file: '/notebooks/C-13_x.ipynb', bytes: '{}' }], releasedFlag: 'true' }));
    expect(flag.status).toBe(1);
    expect(flag.stderr).toContain('released is not true or false');
    const odd = run(tempRoot({ released: [{ file: '/notebooks/sub/C-13_x.ipynb', bytes: '{}' }] }));
    expect(odd.status).toBe(1);
    expect(odd.stderr).toContain('no usable file');
  });

  it('FR-SUG-07 NB-AC-08: a source with a skip-execution or raises-exception cell, or with only optional cells, is refused before nbclient', () => {
    const cell = (tags: string[], cell_type = 'code') => ({ cell_type, metadata: { tags }, source: 'pass' });
    for (const [label, cells, message] of [
      ['skip-execution', [cell(['skip-execution'])], 'skip-execution'],
      ['raises-exception', [cell([]), cell(['raises-exception'])], 'raises-exception'],
      ['only optional', [cell(['optional']), cell([], 'markdown')], 'no code cell left'],
    ] as const) {
      const root = tempRoot({ released: [] });
      mkdirSync(join(root, 'notebooks/technical'), { recursive: true });
      writeFileSync(join(root, 'notebooks/technical/C-13_x.ipynb'), JSON.stringify({ cells }));
      const r = py(['--root', root]);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toContain(message);
      expect(r.stderr, label).toContain('C-13_x.ipynb');
      expect(r.stderr, label).not.toContain('ModuleNotFoundError');   // nbclient is not imported yet
    }
  });

  it('FR-SUG-07: with no released notebook and no source the job passes and says so', () => {
    const r = py(['--root', tempRoot({ released: [] })]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 released notebooks, 0 sources');
  });

  it('FR-SUG-07 NFR-SEC-11: --only refuses a name that is not a source file name, and --out refuses the source folder', () => {
    const root = tempRoot({ released: [] });
    for (const name of ['C-99_none.ipynb', '../C-13_x.ipynb', '/etc/x.ipynb', 'C-13_x.py']) {
      const a = py(['--root', root, '--only', name]);
      expect(a.status, name).toBe(1);
      expect(a.stdout + a.stderr, name).toContain(name);
    }
    // A trailing newline matches a `$` pattern; only a full match is a file name.
    const nl = py(['--root', root, '--only', 'C-13_x.ipynb\n']);
    expect(nl.status).toBe(1);
    expect(nl.stderr).toContain('is not a notebook file name');
    const b = py(['--root', root, '--out', join(root, 'notebooks/technical')]);
    expect(b.status).toBe(1);
  });
});

/**
 * The lock the job installs (SRS 10.5.1): every requirement pinned with == and carrying at least one sha256 hash, nbclient and
 * ipykernel among them. A universal lock (`uv pip compile --universal`) adds an environment marker after the pin
 * (`pywin32==311 ; sys_platform == "win32" \`), which is accepted. Returns the problems found, one line each.
 */
function lockProblems(text: string): string[] {
  const requirements = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('-'));
  const problems: string[] = [];
  const names = new Set<string>();
  for (const line of requirements) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.!+_-]+)(?:\s*;\s*([^-][^\s]*(?:\s+[^\s-][^\s]*)*?))?((?:\s+--hash=sha256:[0-9a-f]{64})+)\s*(?:#.*)?$/.exec(line);
    if (!m) { problems.push(`not a pinned requirement with sha256 hashes: ${line.slice(0, 80)}`); continue; }
    names.add(m[1].toLowerCase().replace(/[-_.]+/g, '-'));
  }
  for (const need of ['nbclient', 'ipykernel']) if (!names.has(need)) problems.push(`${need} is not pinned`);
  return problems;
}
const H = (c: string) => `--hash=sha256:${c.repeat(64)}`;

describe('notebooks/requirements.txt lock', () => {
  it('FR-SUG-07: a hashed lock with environment markers from a universal lock is accepted', () => {
    const lock = [
      '# This file was autogenerated by uv via the following command:',
      '--index-url https://pypi.org/simple',
      `nbclient==0.10.2 \\\n    ${H('a')} \\\n    ${H('b')}`,
      '    # via nbconvert',
      `ipykernel==6.29.5 ${H('c')}`,
      `pywin32==311 ; sys_platform == "win32" \\\n    ${H('d')}`,
      `colorama==0.4.6 ; sys_platform == 'win32' and python_version >= '3.12' ${H('e')}`,
    ].join('\n');
    expect(lockProblems(lock)).toEqual([]);
  });

  it('FR-SUG-07: a line without a hash, an unpinned line, or a lock without nbclient or ipykernel is refused', () => {
    expect(lockProblems(`nbclient==0.10.2 ${H('a')}\nipykernel==6.29.5`).join(';')).toContain('ipykernel==6.29.5');
    expect(lockProblems(`nbclient>=0.10 ${H('a')}\nipykernel==6.29.5 ${H('b')}`).join(';')).toContain('nbclient>=0.10');
    expect(lockProblems(`ipykernel==6.29.5 ${H('b')}`)).toEqual(['nbclient is not pinned']);
    expect(lockProblems(`nbclient==0.10.2 ; sys_platform == "win32"\nipykernel==6.29.5 ${H('b')}`).join(';')).toContain('nbclient==0.10.2');
  });

  it.skipIf(!existsSync('notebooks/requirements.txt'))('FR-SUG-07: the committed lock pins nbclient and ipykernel with hashes', () => {
    expect(lockProblems(readFileSync('notebooks/requirements.txt', 'utf8'))).toEqual([]);
  });
});
