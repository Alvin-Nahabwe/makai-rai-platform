import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseRequirementIds } from '../../scripts/requirements/must-ids.mjs';

/**
 * NFR-MNT-03 (SRS line 3320): every MUST requirement id is named by the title of a test. `must-ids.json` holds
 * the ids (generated from the SRS by `scripts/requirements/must-ids.mjs`, so CI needs no SRS); this file scans
 * the titles in `__tests__` and `e2e` and lists the MUST ids that no title names. Outside a release candidate
 * the list is printed, not failed, because most ids arrive with the units that build them; with
 * RELEASE_CANDIDATE=1 it must be empty.
 */

const IDS = JSON.parse(readFileSync('__tests__/lint/must-ids.json', 'utf8')) as { must: string[]; should: string[] };
const ID_PATTERN = /\b(N?FR-[A-Z0-9]+-\d+)\b/g;

// ---- reading test titles -----------------------------------------------------------------------------------

const MODIFIERS_WITH_ARGUMENTS = new Set(['each', 'for']);

/** Index after the string literal that starts at `i` (a quote, double quote or backtick), honouring escapes. */
function endOfString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Index after the comment that starts at `i`, or `i` when none does. */
function endOfComment(src: string, i: number): number {
  if (src.startsWith('//', i)) {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (src.startsWith('/*', i)) {
    const close = src.indexOf('*/', i + 2);
    return close < 0 ? src.length : close + 2;
  }
  return i;
}

/** Index after the parenthesis that closes the one at `i`, skipping strings and comments inside. */
function endOfParens(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    const afterComment = endOfComment(src, j);
    if (afterComment !== j) j = afterComment;
    else if (c === '"' || c === "'" || c === '`') j = endOfString(src, j);
    else {
      if (c === '(') depth += 1;
      if (c === ')' && --depth === 0) return j + 1;
      j += 1;
    }
  }
  return src.length;
}

const skipSpace = (src: string, i: number) => {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j += 1;
  return j;
};

/**
 * The titles of `it(`, `test(` and `describe(` calls in `src`, with their `.skip`, `.only`, `.fixme`, `.todo`,
 * `.concurrent` and `.each(table)` forms. A title is the first argument when it is a string. Text in comments,
 * and ids in a test body, are not titles.
 */
export function testTitles(src: string): string[] {
  const titles: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const afterComment = endOfComment(src, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(src, i);
      continue;
    }
    const word = /^(?:it|test|describe)\b/.exec(src.slice(i, i + 9));
    if (!word || /[\w$.]/.test(src[i - 1] ?? '')) {
      i += 1;
      continue;
    }
    let j = i + word[0].length;
    for (;;) {
      j = skipSpace(src, j);
      if (src[j] === '.') {
        const modifier = /^\.\s*([A-Za-z]+)/.exec(src.slice(j, j + 40));
        if (!modifier) break;
        j += modifier[0].length;
        if (MODIFIERS_WITH_ARGUMENTS.has(modifier[1])) {
          j = skipSpace(src, j);
          if (src[j] === '(') j = endOfParens(src, j);
          else if (src[j] === '`') j = endOfString(src, j);
        }
        continue;
      }
      break;
    }
    if (src[j] === '(') {
      const k = skipSpace(src, j + 1);
      if (src[k] === '"' || src[k] === "'" || src[k] === '`') {
        const end = endOfString(src, k);
        titles.push(src.slice(k + 1, end - 1));
        i = end;
        continue;
      }
    }
    i = Math.max(j, i + 1);
  }
  return titles;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.auth') return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : [];
  });
}

function idsNamedByTests(roots: readonly string[]): Set<string> {
  const named = new Set<string>();
  for (const file of roots.flatMap(sourceFiles))
    for (const title of testTitles(readFileSync(file, 'utf8'))) for (const m of title.matchAll(ID_PATTERN)) named.add(m[1]);
  return named;
}

/** The MUST ids that no test title in `__tests__` or `e2e` names. */
function mustIdsWithoutTest(): string[] {
  const named = idsNamedByTests(['__tests__', 'e2e']);
  return IDS.must.filter((id) => !named.has(id));
}

// ---- the cases ---------------------------------------------------------------------------------------------

it('NFR-MNT-03: the requirement list has 170 MUST ids (102 FR, 68 NFR) and 14 SHOULD ids', () => {
  expect(IDS.must.filter((i) => i.startsWith('FR-'))).toHaveLength(102);
  expect(IDS.must.filter((i) => i.startsWith('NFR-'))).toHaveLength(68);
  expect(IDS.should).toHaveLength(14);
  // The list is data the check relies on, so its shape is pinned: ids, sorted, unique, and in one list each.
  for (const list of [IDS.must, IDS.should]) {
    expect(list.every((id) => /^N?FR-[A-Z0-9]+-\d+$/.test(id))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort()).toEqual(list);
  }
  expect(IDS.must.filter((id) => IDS.should.includes(id))).toEqual([]);
  expect(IDS.must).toContain('NFR-PERF-04'); // its block holds a table before its priority line (SRS line 3220)
});

it('NFR-MNT-03: every MUST id is named by a test title in __tests__ or e2e', () => {
  const missing = mustIdsWithoutTest(); // titles of it(, test(, describe( and their .each/.skip forms
  console.log(`MUST ids with no test: ${missing.length}\n${missing.join(' ')}`);
  expect(missing.length).toBeLessThan(170); // the parser sees at least this file's own id
  expect(missing).not.toContain('NFR-MNT-03');
  if (process.env.RELEASE_CANDIDATE === '1') expect(missing).toEqual([]);
});

it('NFR-MNT-03: the title reader takes titles of every test form and nothing from comments, bodies or other strings', () => {
  const src = [
    "it('NFR-A-01 plain', () => {});",
    'test("NFR-A-02 double", async () => {});',
    'describe(`NFR-A-03 template`, () => {});',
    "it.skip('NFR-A-04 skipped', () => {});",
    "test.only('NFR-A-05 only', () => {});",
    "it.each([[1, 'a (b)'], [2, 'c']])('NFR-A-06 each %s', () => {});",
    'it.each`\n a | b\n ${1} | ${2}\n`(\'NFR-A-07 table\', () => {});',
    "test.describe('NFR-A-08 playwright group', () => {});",
    "test.fixme('NFR-A-09 quarantined', async () => {});",
    "// it('NFR-A-90 commented out', () => {});",
    "/* test('NFR-A-91 block comment', () => {}); */",
    "const note = \"it('NFR-A-92 in a string', () => {})\";",
    "it('NFR-A-10 names the title only', () => { expect('NFR-A-93 in the body').toBe('x'); });",
    "test.skip(true, 'NFR-A-94 a skip condition is not a title');",
    "test.beforeEach(async () => { /* it('NFR-A-95') */ });",
    "foo.it('NFR-A-96 a method called it', () => {});",
    "const submit = (x) => x; submit('NFR-A-97 wrong function');",
  ].join('\n');
  const found = testTitles(src).flatMap((t) => [...t.matchAll(ID_PATTERN)].map((m) => m[1]));
  expect(found).toEqual(['NFR-A-01', 'NFR-A-02', 'NFR-A-03', 'NFR-A-04', 'NFR-A-05', 'NFR-A-06', 'NFR-A-07', 'NFR-A-08', 'NFR-A-09', 'NFR-A-10']);
});

it('NFR-MNT-03: the id reader takes whole ids only, with their digits', () => {
  const found = (s: string) => [...s.matchAll(ID_PATTERN)].map((m) => m[1]);
  expect(found('FR-DEC-01 NFR-SEC-17 and NFR-A11Y-04 (G-17)')).toEqual(['FR-DEC-01', 'NFR-SEC-17', 'NFR-A11Y-04']);
  expect(found('XFR-DEC-01 FR-DEC- FR-DEC-NN')).toEqual([]);
});

const SAMPLE_SRS = [
  'Format of each requirement:',
  '',
  '> **NFR-AREA-NN** The system shall ...',
  '> - *Traces:* FR ids, aims · *Priority:* MUST or SHOULD.',
  '',
  '## 3.1 Requirements',
  '',
  '> **FR-ONE-01** The system shall do one.',
  '> - *Traces:* A · *Priority:* MUST.',
  '',
  '> **FR-ONE-02** The system shall do two.',
  '> - *Aims:* I1 · *Priority:* SHOULD · *Reuse:* none.',
  '',
  '> **NFR-PERF-04** The system shall meet these budgets.',
  '> - *Target:* measured with:',
  '',
  '| Operation | p95 |',
  '|---|---|',
  '| Save | 300 ms |',
  '',
  '> - *Traces:* FR-ONE-01 · *Priority:* MUST.',
  '',
  '> **NFR-A11Y-02** The system shall be usable.',
  '> - *Traces:* FR-ONE-01 · *Priority:* MUST.',
  '',
  '## 4. Next section',
  'Text that says *Priority:* SHOULD outside any requirement.',
].join('\n');

it('NFR-MNT-03: the id parser reads each block, takes the priority of its last line, and skips the format template', () => {
  expect(parseRequirementIds(SAMPLE_SRS)).toEqual({ must: ['FR-ONE-01', 'NFR-A11Y-02', 'NFR-PERF-04'], should: ['FR-ONE-02'] });
  // A block with no priority is an error, never a silent omission: the list would be short for the wrong reason.
  expect(() => parseRequirementIds('> **FR-ONE-01** The system shall do one.\n> - *Aims:* I1\n')).toThrow(/FR-ONE-01/);
  expect(() => parseRequirementIds('> **FR-ONE-01** a\n> - *Priority:* MUST.\n> **FR-ONE-01** b\n> - *Priority:* MUST.\n')).toThrow(/twice/);
});

it('NFR-MNT-03: the id script prints the JSON of the parser for a file it is given, and exits 2 for a file it cannot use', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const run = (args: string[]) => spawnSync(process.execPath, ['scripts/requirements/must-ids.mjs', ...args], { encoding: 'utf8', env });
  const dir = mkdtempSync(join(tmpdir(), 'must-ids-'));
  try {
    const sample = join(dir, 'srs.md');
    writeFileSync(sample, SAMPLE_SRS);
    const ok = run([sample]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(parseRequirementIds(SAMPLE_SRS));
    const bad = join(dir, 'bad.md');
    writeFileSync(bad, '> **FR-ONE-01** The system shall do one.\n');
    const noPriority = run([bad]);
    expect(noPriority.status).toBe(2);
    expect(noPriority.stderr).toContain('FR-ONE-01');
    expect(noPriority.stdout).toBe(''); // nothing half-written for a redirect to save
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const missing = run([join(tmpdir(), 'does-not-exist.md')]);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toMatch(/does-not-exist\.md/);
  expect(run([]).status).toBe(2);
});
