import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The legal text registry (FR-ACC-02, SRS 6.7). The actual module is used, not
 * the stub registry `__tests__/setup/legal.ts` installs for the gate's tests.
 * Malformed registries are written into the OS temporary directory, not
 * committed, so no broken legal text file ever sits in the repository.
 */

type RegistryModule = typeof import('@/lib/legal/registry');
const { loadLegalRegistry, currentLegalText, legalTextHistory, legalTextVersion, legalKindFrom, LEGAL_KINDS, LEGAL_KIND_NAMES } =
  await vi.importActual<RegistryModule>('@/lib/legal/registry');

const FIX = '__tests__/fixtures/legal';
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

const header = (kind: string, version: string, published = '2026-11-02', acceptance = 'required'): string =>
  `kind: ${kind}\nversion: ${version}\npublished: ${published}\nacceptance: ${acceptance}\n`;
const file = (kind: string, version: string, published?: string, acceptance?: string): string =>
  `${header(kind, version, published, acceptance)}---\nSome text.\n`;

/** Each malformed registry: the files it holds (path under the root) and what the refusal must name. */
const MALFORMED: Array<[string, Record<string, string | Buffer>, RegExp]> = [
  ['a header kind that disagrees with its directory', { 'privacy/1.md': file('terms', '1') }, /kind/],
  ['a missing acceptance key', { 'privacy/1.md': 'kind: privacy\nversion: 1\npublished: 2026-11-02\n---\nSome text.\n' }, /acceptance/],
  ['a header version that disagrees with its file name', { 'privacy/2.md': file('privacy', '1') }, /version/],
  ['a file name that is not a version', { 'privacy/v1.md': file('privacy', 'v1') }, /file name/],
  ['a file that is not markdown', { 'privacy/1.txt': file('privacy', '1') }, /file name/],
  ['an unknown header key', { 'privacy/1.md': `${header('privacy', '1')}author: someone\n---\nSome text.\n` }, /unknown header key/],
  ['a header key given twice', { 'privacy/1.md': `kind: privacy\n${header('privacy', '1')}---\nSome text.\n` }, /more than once/],
  ['a header line that is not "key: value"', { 'privacy/1.md': `${header('privacy', '1')}just words\n---\nSome text.\n` }, /header line/],
  ['no line holding only ---', { 'privacy/1.md': header('privacy', '1') }, /---/],
  ['an empty text', { 'privacy/1.md': `${header('privacy', '1')}---\n  \n\n` }, /empty/],
  ['an impossible publication date', { 'privacy/1.md': file('privacy', '1', '2026-02-30') }, /published/],
  ['a publication date in another form', { 'privacy/1.md': file('privacy', '1', '2 Nov 2026') }, /published/],
  ['an acceptance that is neither required nor offered', { 'privacy/1.md': file('privacy', '1', '2026-11-02', 'maybe') }, /acceptance/],
  ['carriage returns', { 'privacy/1.md': file('privacy', '1').replaceAll('\n', '\r\n') }, /carriage return/],
  ['a byte order mark', { 'privacy/1.md': `\uFEFF${file('privacy', '1')}` }, /byte order mark/],
  ['bytes that are not UTF-8', { 'privacy/1.md': Buffer.concat([Buffer.from(`${header('privacy', '1')}---\n`), Buffer.from([0xff, 0xfe, 0x0a])]) }, /UTF-8/],
  ['two versions that differ only in letter case', { 'privacy/1a.md': file('privacy', '1a'), 'privacy/1A.md': file('privacy', '1A', '2026-12-01') }, /same version/],
  ['a later version published before an earlier one', { 'privacy/1.md': file('privacy', '1', '2026-12-01'), 'privacy/2.md': file('privacy', '2', '2026-11-02') }, /published/],
  ['two versions published on the same day', { 'privacy/1.md': file('privacy', '1'), 'privacy/2.md': file('privacy', '2') }, /published/],
  ['two versions the order cannot tell apart', { 'privacy/1.md': file('privacy', '1'), 'privacy/01.md': file('privacy', '01', '2026-12-01') }, /same version/],
  ['two decimal versions the order cannot tell apart', { 'privacy/1.0.md': file('privacy', '1.0'), 'privacy/1.00.md': file('privacy', '1.00', '2026-12-01') }, /same version/],
  ['a directory where a version file belongs', { 'privacy/1.md': file('privacy', '1'), 'privacy/2.md/x': 'x' }, /privacy\/2\.md: is not a file/],
  ['a kind directory with a mistyped name', { 'terms/1.md': file('terms', '1'), 'term/2.md': file('terms', '2', '2026-12-01') }, /"term" is not one of the four kinds/],
  ['a version file outside any kind directory', { 'terms/1.md': file('terms', '1'), 'terms-2.md': file('terms', '2', '2026-12-01') }, /"terms-2\.md" is not one of the four kinds/],
  ['a text with no letter or digit', { 'privacy/1.md': `${header('privacy', '1')}---\n${String.fromCharCode(0x200b)}\n` }, /no letter or digit/],
  ['a control character', { 'privacy/1.md': `${header('privacy', '1')}---\nSome${String.fromCharCode(7)} text.\n` }, /control character/],
  // A bidirectional control shows the words in an order other than the hashed bytes' (U+202E reverses what follows).
  ['a right-to-left override', { 'privacy/1.md': `${header('privacy', '1')}---\nSome \u202Etxet.\n` }, /control character U\+202E/],
  ['a left-to-right mark', { 'privacy/1.md': `${header('privacy', '1')}---\nSome\u200E text.\n` }, /control character U\+200E/],
  ['a C1 control', { 'privacy/1.md': `${header('privacy', '1')}---\nSome\u0085 text.\n` }, /control character U\+0085/],
];

let base: string;
const roots = new Map<string, string>();

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'acc-a-legal-'));
  MALFORMED.forEach(([name, files], i) => {
    const root = join(base, `malformed-${i}`);
    writeTree(root, files);
    roots.set(name, root);
  });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('legal text registry', () => {
  it('FR-ACC-02: each version carries kind, version, date, acceptance and the SHA-256 of its file', () => {
    const r = loadLegalRegistry(FIX);
    expect(r.get('privacy')!.map((t) => [t.kind, t.version, t.publishedOn, t.acceptance])).toEqual([
      ['privacy', '1', '2026-11-02', 'required'], ['privacy', '2', '2026-12-01', 'offered']]);
    expect(r.get('privacy')![0].sha256).toBe(sha(`${FIX}/privacy/1.md`));
    expect(r.get('privacy')![1].sha256).toBe(sha(`${FIX}/privacy/2.md`));
    expect(r.get('privacy')![1].text).toBe(
      'Fixture privacy notice, version 2. For tests only.\n\nSecond paragraph of the fixture privacy notice, version 2.\n');
    expect(r.get('terms')!.map((t) => t.version)).toEqual(['1']);
  });

  it.each(MALFORMED)('FR-ACC-02: %s stops the load', (name, _files, refusal) => {
    expect(() => loadLegalRegistry(roots.get(name)!)).toThrow(refusal);
  });

  it('FR-ACC-02: a registry root that does not exist stops the load rather than reading as empty', () => {
    expect(() => loadLegalRegistry(join(base, 'no-such-root'))).toThrow(/ENOENT/);
  });

  it('FR-ACC-02: the shipped registry has version 1 of all four kinds and hashes its own files', () => {
    for (const k of ['terms', 'privacy', 'cross-border-consent', 'organisation-agreement'] as const) {
      expect(currentLegalText(k).version).toBe('1');
      expect(currentLegalText(k).sha256).toBe(sha(`data/legal/${k}/1.md`));
      expect(legalTextHistory(k)).toHaveLength(1);
    }
    expect(legalTextVersion('privacy', '1')).toBe(currentLegalText('privacy'));
    expect(legalTextVersion('privacy', '9')).toBeNull();
    expect(legalTextVersion('privacy', '../terms/1')).toBeNull();
  });

  it('FR-ACC-02: a kind or version looked up from a request never reaches an object prototype', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(legalTextVersion(k as 'privacy', '1')).toBeNull();
      expect(() => legalTextHistory(k as 'privacy')).toThrow(/unknown legal text kind/);
    }
    expect(legalTextVersion('privacy', 'constructor')).toBeNull();
  });

  it('FR-ACC-02: a kind taken from a request is one of the four by exact equality, or null', () => {
    for (const k of LEGAL_KINDS) expect(legalKindFrom(k)).toBe(k);
    for (const s of ['constructor', '__proto__', 'toString', 'Privacy', 'privacy ', ' terms', 'x', '', '../privacy']) {
      expect(legalKindFrom(s), JSON.stringify(s)).toBeNull();
    }
  });

  it('FR-ACC-02: callers cannot change the registry through what it returns', () => {
    const history = legalTextHistory('privacy');
    history.pop();
    expect(legalTextHistory('privacy')).toHaveLength(1);
    expect(Object.isFrozen(currentLegalText('privacy'))).toBe(true);
    expect(() => { (currentLegalText('privacy') as { sha256: string }).sha256 = '0'; }).toThrow(TypeError);
  });

  it('FR-ACC-02: LEGAL_KINDS lists the four kinds, each with its SRS 7.5.7 name', () => {
    expect(LEGAL_KINDS).toEqual(['terms', 'privacy', 'cross-border-consent', 'organisation-agreement']);
    expect(LEGAL_KIND_NAMES).toEqual({
      terms: 'terms of service',
      privacy: 'privacy notice',
      'cross-border-consent': 'cross-border storage consent',
      'organisation-agreement': 'organisation agreement',
    });
  });
});

/**
 * The production registry reads `data/legal` under `process.cwd()` once, at
 * module load. These cases point `process.cwd()` at a temporary tree and load
 * a fresh copy of the module, so the production read path itself is exercised.
 */
/** `published.json` for every version file under `root`, as Task 13 Step 4b writes the shipped one. */
function publishedFor(root: string): Array<{ kind: string; version: string; sha256: string }> {
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .flatMap((k) => readdirSync(join(root, k)).sort().map((f) => ({ kind: k, version: f.replace(/\.md$/, ''), sha256: sha(join(root, k, f)) })));
}
function writePublished(root: string, entries: unknown = publishedFor(root)): void {
  writeFileSync(join(root, 'published.json'), JSON.stringify(entries, null, 2) + '\n');
}

describe('data/legal/published.json: a published text cannot change (FR-ACC-02)', () => {
  /** A copy of the fixture tree (privacy 1 and 2, terms 1) with its published.json. */
  function publishedCopy(name: string): string {
    const root = join(base, `published-${name}`);
    cpSync(FIX, root, { recursive: true });
    writePublished(root);
    return root;
  }

  it('FR-ACC-02: a tree whose published.json lists every file with its hash loads', () => {
    expect(loadLegalRegistry(publishedCopy('ok')).get('privacy')?.map((t) => t.version)).toEqual(['1', '2']);
  });

  it('FR-ACC-02: an edited published file refuses to load, naming published.json and the entry', () => {
    const tmp = publishedCopy('edited');
    appendFileSync(join(tmp, 'privacy', '1.md'), 'x');
    expect(() => loadLegalRegistry(tmp)).toThrow(/published\.json.*privacy\/1.*sha256/);
  });

  it('FR-ACC-02: a published file that is missing refuses to load', () => {
    const tmp = publishedCopy('missing');
    rmSync(join(tmp, 'privacy', '2.md'));
    expect(() => loadLegalRegistry(tmp)).toThrow(/published\.json.*privacy\/2.*missing/);
  });

  it('FR-ACC-02: a version file that no entry lists refuses to load, naming published.json and the file', () => {
    const tmp = publishedCopy('unlisted');
    writeFileSync(join(tmp, 'privacy', '3.md'), file('privacy', '3', '2027-01-04'));
    expect(() => loadLegalRegistry(tmp)).toThrow(/published\.json.*privacy\/3.*not listed/);
  });

  it('FR-ACC-02: a duplicate (kind, version) entry, a malformed entry and a stray file beside the kind directories refuse to load', () => {
    const dup = publishedCopy('duplicate');
    const entries = publishedFor(dup);
    writePublished(dup, [...entries, entries[0]]);
    expect(() => loadLegalRegistry(dup)).toThrow(/published\.json.*privacy\/1.*more than once/);
    for (const [i, bad] of [{ kind: 'privacy', version: '1' }, { kind: 'privacy', version: 1, sha256: 'a'.repeat(64) },
      { kind: 'privcy', version: '1', sha256: 'a'.repeat(64) }, { kind: 'privacy', version: '1', sha256: 'A'.repeat(64) },
      { kind: 'privacy', version: '1', sha256: 'a'.repeat(64), note: 'x' }].entries()) {
      const root = publishedCopy(`malformed-entry-${i}`);
      writePublished(root, [...publishedFor(root), bad]);
      expect(() => loadLegalRegistry(root), JSON.stringify(bad)).toThrow(/published\.json: entry \d+ is not \{ kind, version, sha256 \}/);
    }
    const notList = publishedCopy('not-a-list');
    writePublished(notList, { privacy: [] });
    expect(() => loadLegalRegistry(notList)).toThrow(/published\.json is not a list/);
    const stray = publishedCopy('stray');
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect(() => loadLegalRegistry(stray)).toThrow(/"notes\.txt" is not one of the four kinds/);
  });

  it('FR-ACC-02: the shipped published.json lists every shipped version file, and nothing else', () => {
    const listed = JSON.parse(readFileSync('data/legal/published.json', 'utf8')).map((e: { kind: string; version: string }) => `${e.kind}/${e.version}.md`).sort();
    expect(listed).toEqual(LEGAL_KINDS.flatMap((k) => readdirSync(`data/legal/${k}`).map((f) => `${k}/${f}`)).sort());
  });
});

describe('legal text registry, production read path', () => {
  const ALL_KINDS = ['terms', 'privacy', 'cross-border-consent', 'organisation-agreement'];
  let cwdBase: string;

  beforeAll(() => { cwdBase = mkdtempSync(join(tmpdir(), 'acc-a-legal-cwd-')); });
  afterAll(() => rmSync(cwdBase, { recursive: true, force: true }));
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  async function loadWithCwd(cwd: string): Promise<RegistryModule> {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.resetModules();
    return vi.importActual<RegistryModule>('@/lib/legal/registry');
  }

  it('FR-ACC-02: a kind with no file makes currentLegalText throw rather than serve no text', async () => {
    const cwd = join(cwdBase, 'empty-privacy');
    for (const k of ALL_KINDS) mkdirSync(join(cwd, 'data', 'legal', k), { recursive: true });
    for (const k of ALL_KINDS.filter((k) => k !== 'privacy')) writeTree(join(cwd, 'data', 'legal'), { [`${k}/1.md`]: file(k, '1') });
    writePublished(join(cwd, 'data', 'legal'));
    const m = await loadWithCwd(cwd);
    expect(m.currentLegalText('terms').version).toBe('1');
    expect(() => m.currentLegalText('privacy')).toThrow('no legal text of kind privacy');
    expect(() => m.legalTextHistory('privacy')).toThrow('no legal text of kind privacy');
  });

  it('FR-ACC-02: a missing kind directory stops the module from loading, naming the directory', async () => {
    const cwd = join(cwdBase, 'no-agreement');
    for (const k of ALL_KINDS.filter((k) => k !== 'organisation-agreement')) writeTree(join(cwd, 'data', 'legal'), { [`${k}/1.md`]: file(k, '1') });
    await expect(loadWithCwd(cwd)).rejects.toThrow(/data\/legal\/organisation-agreement is missing/);
  });

  it('FR-ACC-02: the production registry refuses to load without data/legal/published.json', async () => {
    const cwd = join(cwdBase, 'no-published');
    for (const k of ALL_KINDS) writeTree(join(cwd, 'data', 'legal'), { [`${k}/1.md`]: file(k, '1') });
    await expect(loadWithCwd(cwd)).rejects.toThrow(/data\/legal\/published\.json is missing/);
  });

  it('FR-ACC-02: a missing data/legal stops the module from loading', async () => {
    const cwd = join(cwdBase, 'no-legal');
    mkdirSync(join(cwd, 'data'), { recursive: true });
    await expect(loadWithCwd(cwd)).rejects.toThrow(/ENOENT/);
  });

  it('FR-ACC-02: a malformed shipped file stops the module from loading', async () => {
    const cwd = join(cwdBase, 'malformed-terms');
    for (const k of ALL_KINDS) writeTree(join(cwd, 'data', 'legal'), { [`${k}/1.md`]: file(k === 'terms' ? 'privacy' : k, '1') });
    await expect(loadWithCwd(cwd)).rejects.toThrow(/kind/);
  });
});
