import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_BUNDLE_FILES, computeVersionBundleHash } from '@/lib/content/bundleHash';
import { parseResources } from '@/lib/content/resources';
import { contentRoot, runningSemver } from '@/lib/content/root';
import type { ResourcesFile } from '@/types/content';

/**
 * The release resources file `data/resources.json` (FR-CNT-05): which control has a reviewed template or notebook,
 * kept outside the hashed content files so a new notebook does not make a new content version. Its paths become
 * links on S-27, so the format is checked entry by entry (contract Services row "`data/resources.json` paths").
 * `controlId` is checked against the running content, which here is H0's fixture bundle (its 28 controls are the
 * 4.0.0 ones).
 */

const T = { controlId: 'C-01', file: '/templates/C-01_alternatives-analysis.html', kind: 'web page', bytes: 10240, sha256: 'c'.repeat(64), review: { reviewer: 'r', date: '2026-10-30', outcome: 'passed' } };
const N = { controlId: 'C-13', file: '/notebooks/C-13_subgroup-fairness.ipynb', requirementsFile: '/notebooks/requirements.txt', sha256: 'a'.repeat(64), bytes: 48000, review: { reviewer: 'r', date: '2026-10-31', outcome: 'passed' }, released: true };

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
});

/**
 * CI's check of the served files (not the runtime parse): every template and notebook entry's `public/<file>` (and a
 * notebook's `public/<requirementsFile>`) exists, and its size and SHA-256 are the entry's `bytes` and `sha256`, so a
 * misspelt name or a file edited after its review cannot ship. One line per problem.
 */
function servedFileProblems(r: ResourcesFile, publicDir: string): string[] {
  const problems: string[] = [];
  const entries = [...r.templates.map((t, i) => ({ at: `templates[${i}]`, ...t })), ...r.notebooks.map((n, i) => ({ at: `notebooks[${i}]`, ...n }))];
  for (const e of entries) {
    const path = join(publicDir, e.file);
    if (!existsSync(path)) {
      problems.push(`${e.at}: public${e.file} does not exist`);
      continue;
    }
    const bytes = readFileSync(path);
    if (statSync(path).size !== e.bytes) problems.push(`${e.at}: public${e.file} has ${bytes.length} bytes, not ${e.bytes}`);
    if (createHash('sha256').update(bytes).digest('hex') !== e.sha256) problems.push(`${e.at}: public${e.file} does not have the reviewed sha256`);
  }
  for (const [i, n] of r.notebooks.entries()) if (!existsSync(join(publicDir, n.requirementsFile))) problems.push(`notebooks[${i}]: public${n.requirementsFile} does not exist`);
  return problems;
}

describe('resources file', () => {
  it('FR-CNT-05: the real resources file parses', () => { expect(parseResources(JSON.parse(readFileSync('data/resources.json', 'utf8')))).toBeTruthy(); });

  it('FR-CNT-05 NFR-SEC-11: parseResources refuses paths outside templates and notebooks', () => {
    for (const file of ['../.env', 'templates/x.html', '/templates/../x.html', 'javascript:alert(1)', '/notebooks/x.ipynb', '/templates/x.htm', '//evil.example/x.html'])
      expect(() => parseResources({ templates: [{ ...T, file }], notebooks: [] })).toThrow(/templates\[0\]\.file/);
    for (const requirementsFile of ['/notebooks/../.env', '/templates/requirements.txt', 'requirements.txt'])
      expect(() => parseResources({ templates: [], notebooks: [{ ...N, requirementsFile }] })).toThrow(/notebooks\[0\]\.requirementsFile/);
    expect(() => parseResources({ templates: [{ ...T, controlId: 'C-99' }], notebooks: [] })).toThrow(/C-99/);
  });

  it('FR-CNT-05 FR-SUG-04: two entries of one kind for one control are refused, because a card links only one of them', () => {
    expect(() => parseResources({ templates: [T, { ...T, file: '/templates/C-01_other.html' }], notebooks: [] })).toThrow(/templates\[1\]\.controlId.*C-01/);
    expect(() => parseResources({ templates: [], notebooks: [N, { ...N, file: '/notebooks/C-13_other.ipynb', released: false }] })).toThrow(/notebooks\[1\]\.controlId.*C-13/);
    expect(parseResources({ templates: [T], notebooks: [N] })).toBeTruthy();   // one of each, for different or the same control, is fine
  });

  it('FR-CNT-05 NB-AC-10: a template needs its sha256 and a released notebook needs a passed review', () => {
    expect(parseResources({ templates: [T], notebooks: [N] })).toEqual({ templates: [T], notebooks: [N] });
    const { sha256: _drop, ...noHash } = T;
    expect(() => parseResources({ templates: [noHash], notebooks: [] })).toThrow(/templates\[0\]\.sha256/);
    expect(() => parseResources({ templates: [], notebooks: [{ ...N, review: { ...N.review, outcome: 'failed' } }] })).toThrow(/notebooks\[0\]\.released/);
    expect(parseResources({ templates: [], notebooks: [{ ...N, review: { ...N.review, outcome: 'failed' }, released: false }] }).notebooks).toHaveLength(1);
  });

  it('FR-CNT-05: adding a notebook entry to the resources file leaves the bundle hash unchanged', () => {
    const dir = join(contentRoot(), runningSemver());
    const before = computeVersionBundleHash(dir);
    expect(CONTENT_BUNDLE_FILES).not.toContain('resources.json' as never);
    expect(existsSync(join(dir, 'resources.json'))).toBe(false);
    expect(computeVersionBundleHash(dir)).toBe(before);
  });

  it('FR-CNT-05 NFR-SEC-11: every field rule names the entry and field it refuses, and a later entry is named by its own index', () => {
    // [entry to merge into T or N, kind, the field the message must name]
    const cases: Array<[Record<string, unknown>, 'templates' | 'notebooks', string]> = [
      [{ kind: '' }, 'templates', 'kind'],
      [{ kind: 3 }, 'templates', 'kind'],
      [{ bytes: 0 }, 'templates', 'bytes'],
      [{ bytes: 1.5 }, 'templates', 'bytes'],
      [{ bytes: '10240' }, 'templates', 'bytes'],
      [{ sha256: 'C'.repeat(64) }, 'templates', 'sha256'],
      [{ sha256: 'c'.repeat(63) }, 'notebooks', 'sha256'],
      [{ review: { ...T.review, reviewer: '' } }, 'templates', 'review.reviewer'],
      [{ review: { ...T.review, date: '30 Oct 2026' } }, 'templates', 'review.date'],
      [{ review: { ...T.review, date: '2026-02-30' } }, 'notebooks', 'review.date'],
      [{ review: { ...T.review, outcome: 'pass' } }, 'templates', 'review.outcome'],
      [{ review: null }, 'notebooks', 'review'],
      [{ released: 'true' }, 'notebooks', 'released'],
      [{ controlId: 7 }, 'templates', 'controlId'],
    ];
    for (const [change, kind, field] of cases) {
      const entry = { ...(kind === 'templates' ? T : N), ...change };
      const file = kind === 'templates' ? { templates: [T, entry], notebooks: [] } : { templates: [], notebooks: [N, entry] };
      expect(() => parseResources(file), `${kind} ${JSON.stringify(change)}`).toThrow(`${kind}[1].${field}`);
    }
  });

  it('FR-CNT-05: a misspelled or unknown key is refused, never ignored, so a field cannot be lost to a typo', () => {
    expect(() => parseResources({ templates: [{ ...T, relased: true }], notebooks: [] })).toThrow(/templates\[0\]\.relased/);
    expect(() => parseResources({ templates: [], notebooks: [{ ...N, review: { ...N.review, outcom: 'passed' } }] })).toThrow(/notebooks\[0\]\.review\.outcom/);
    expect(() => parseResources({ templates: [], notebooks: [], extra: [] })).toThrow(/extra/);
    for (const raw of [null, [], 'x', { templates: [] }, { notebooks: [] }, { templates: {}, notebooks: [] }, { templates: [], notebooks: [null] }])
      expect(() => parseResources(raw), JSON.stringify(raw)).toThrow(/resources\.json/);
  });

  it('FR-CNT-05: the parsed file is a copy, so a change to the input after parsing does not reach the result', () => {
    const input = { templates: [{ ...T, review: { ...T.review } }], notebooks: [] };
    const out = parseResources(input);
    input.templates[0].review.outcome = 'failed';
    input.templates[0].file = 'javascript:alert(1)';
    expect(out).toEqual({ templates: [T], notebooks: [] });
  });

  it('FR-CNT-05: loadResources reads data/resources.json once and returns it parsed', async () => {
    const reads: string[] = [];
    vi.doMock('node:fs', async (orig) => {
      const fs = await orig<typeof import('node:fs')>();
      return { ...fs, readFileSync: ((p: string, ...rest: unknown[]) => { reads.push(String(p)); return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof fs.readFileSync };
    });
    const m = await import('@/lib/content/resources');
    const a = m.loadResources();
    expect(a).toEqual(JSON.parse(readFileSync('data/resources.json', 'utf8')));
    expect(m.loadResources()).toBe(a);
    expect(reads.filter((p) => p === join(process.cwd(), 'data', 'resources.json'))).toHaveLength(1);
  });

  it('FR-CNT-05: a resources file that is not JSON is a plain error naming data/resources.json, and a failed load is not cached', async () => {
    let text = '{"templates": [';
    vi.doMock('node:fs', async (orig) => {
      const fs = await orig<typeof import('node:fs')>();
      return { ...fs, readFileSync: ((p: string, ...rest: unknown[]) => (String(p).endsWith(join('data', 'resources.json')) ? text : (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fs.readFileSync };
    });
    const m = await import('@/lib/content/resources');
    let caught: unknown;
    try { m.loadResources(); } catch (e) { caught = e; }
    expect((caught as Error).message).toBe('data/resources.json: not valid JSON');
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
    text = '{"templates": [], "notebooks": [], "extra": 1}';
    expect(() => m.loadResources()).toThrow(/extra/);
    text = '{"templates": [], "notebooks": []}';
    expect(m.loadResources()).toEqual({ templates: [], notebooks: [] });
  });

  it('FR-CNT-05 FR-SUG-06 NB-AC-10: every file the resources file lists is in public/ with the reviewed size and SHA-256', () => {
    expect(servedFileProblems(parseResources(JSON.parse(readFileSync('data/resources.json', 'utf8'))), 'public')).toEqual([]);
  });

  it('FR-CNT-05 FR-SUG-06: the served-file check refuses a missing file, a changed byte and a wrong size', () => {
    const pub = mkdtempSync(join(tmpdir(), 'cnt-public-'));
    try {
      mkdirSync(join(pub, 'templates')); mkdirSync(join(pub, 'notebooks'));
      const page = Buffer.from('<!doctype html><title>t</title>\n');
      writeFileSync(join(pub, 'templates', 'C-01_alternatives-analysis.html'), page);
      writeFileSync(join(pub, 'notebooks', 'requirements.txt'), 'pandas==2.2.3\n');
      const nb = Buffer.from('{"cells":[]}\n');
      writeFileSync(join(pub, 'notebooks', 'C-13_subgroup-fairness.ipynb'), nb);
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      const good = { templates: [{ ...T, bytes: page.length, sha256: sha(page) }], notebooks: [{ ...N, bytes: nb.length, sha256: sha(nb) }] };
      expect(servedFileProblems(parseResources(good), pub)).toEqual([]);
      // a byte changed after the review, same length
      writeFileSync(join(pub, 'templates', 'C-01_alternatives-analysis.html'), Buffer.from(page.toString().replace('t</title>', 'x</title>')));
      expect(servedFileProblems(parseResources(good), pub)).toEqual(['templates[0]: public/templates/C-01_alternatives-analysis.html does not have the reviewed sha256']);
      // a file the entry names that is not there, and a size that is not the file's
      rmSync(join(pub, 'notebooks', 'C-13_subgroup-fairness.ipynb'));
      rmSync(join(pub, 'notebooks', 'requirements.txt'));
      const wrongSize = { ...good, templates: [{ ...good.templates[0], bytes: page.length + 1 }] };
      expect(servedFileProblems(parseResources(wrongSize), pub)).toEqual([
        `templates[0]: public/templates/C-01_alternatives-analysis.html has ${page.length} bytes, not ${page.length + 1}`,
        'templates[0]: public/templates/C-01_alternatives-analysis.html does not have the reviewed sha256',
        'notebooks[0]: public/notebooks/C-13_subgroup-fairness.ipynb does not exist',
        'notebooks[0]: public/notebooks/requirements.txt does not exist',
      ]);
    } finally {
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it('FR-CNT-05 NFR-SEC-11: the resources module reads only data/resources.json, through a literal path', () => {
    const src = readFileSync('lib/content/resources.ts', 'utf8');
    expect(src).toContain("join(process.cwd(), 'data', 'resources.json')");
    expect(src.match(/readFileSync\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/computeVersionBundleHash|contentRoot\(|@\/lib\/content\/validate/);
  });
});

