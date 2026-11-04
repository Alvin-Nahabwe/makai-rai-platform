import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function tempRoot(o: { released: Array<{ file: string; bytes: string }> }): string {
  const root = mkdtempSync(join(tmpdir(), 'nbjob-'));
  roots.push(root);
  const notebooks = o.released.map((n) => {
    const path = join(root, 'public', n.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, n.bytes);
    return {
      controlId: 'C-13', file: n.file, requirementsFile: '/notebooks/requirements.txt', bytes: n.bytes.length,
      sha256: createHash('sha256').update(n.bytes).digest('hex'),
      review: { reviewer: 'r', date: '2026-10-31', outcome: 'passed' }, released: true,
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
    const b = py(['--root', root, '--out', join(root, 'notebooks/technical')]);
    expect(b.status).toBe(1);
  });
});
