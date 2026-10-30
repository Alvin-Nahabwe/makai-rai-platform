import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
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

const TEST_FUNCTIONS = new Set(['it', 'test', 'describe']);

/** `.js`, `.mjs` and `.cjs` files are read as JavaScript, `.tsx` and `.jsx` with JSX, everything else as TypeScript. */
function scriptKindOf(fileName: string): ts.ScriptKind {
  if (/\.[cm]?jsx?$/.test(fileName)) return /\.jsx$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  return /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * The identifier a call's callee chain starts from, and the member names on the way: `it.skip.each(t)` gives
 * `it` and `['skip', 'each']`, `it.each\`t\`` and `test.describe` likewise. `null` when the chain starts from
 * anything but a plain identifier (`foo.it(...)` starts from `foo`, `expect(x).toBe(y)` from `expect`).
 */
function calleeChain(callee: ts.Expression): { root: string; members: string[] } | null {
  const members: string[] = [];
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      members.unshift(node.name.text);
      node = node.expression;
    } else if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
    else if (ts.isParenthesizedExpression(node)) node = node.expression;
    else break;
  }
  return ts.isIdentifier(node) ? { root: node.text, members } : null;
}

/**
 * The titles of `it(`, `test(` and `describe(` calls in `src`, with their `.skip`, `.only`, `.fixme`, `.todo`,
 * `.concurrent` and `.each(table)` forms. A title is the first argument when it is a string literal, a template
 * without substitutions or the head of a template with them. Read with the TypeScript compiler, so a regex literal,
 * a template or a comment cannot make the reader lose its place; text in comments, and ids in a test body, are
 * not titles.
 */
export function testTitles(src: string, fileName = 'file.ts'): string[] {
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const first = node.arguments[0];
      if (chain && TEST_FUNCTIONS.has(chain.root) && first) {
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) titles.push(first.text);
        else if (ts.isTemplateExpression(first)) titles.push(first.head.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, scriptKindOf(fileName)));
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
    for (const title of testTitles(readFileSync(file, 'utf8'), file)) for (const m of title.matchAll(ID_PATTERN)) named.add(m[1]);
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

it('NFR-MNT-03: the title reader is not thrown off by a regex literal that holds a quote, nor by a template that holds a call', () => {
  // The refuter's examples: a quote inside a regex literal opened a string in a hand-written reader, and the titles that
  // followed it were lost (FR-ACC-04, FR-DEC-06, FR-MEM-04, FR-MEM-05 and FR-PRJ-03 read as having no test).
  const src = [
    'const publicOnly = /("?public"?\\.)?/;',
    "it('NFR-R-01 after a regex literal with quotes', () => {});",
    "const quotes = /[\"'`]/g;",
    "it('NFR-R-02 after a regex literal with every kind of quote', () => {});",
    "const body = `a ${x} it('NFR-R-99 inside a template') b`;",
    'describe(`NFR-R-03 a template head ${suffix}`, () => {});',
    "const division = a / b; it('NFR-R-04 after a division', () => {});",
    "it.each(['a (b)'])('NFR-R-05 %s', () => {});",
    "describe('NFR-R-06 outer', () => { it('NFR-R-07 nested', () => {}); });",
  ].join('\n');
  const found = testTitles(src).flatMap((t) => [...t.matchAll(ID_PATTERN)].map((m) => m[1]));
  expect(found).toEqual(['NFR-R-01', 'NFR-R-02', 'NFR-R-03', 'NFR-R-04', 'NFR-R-05', 'NFR-R-06', 'NFR-R-07']);
});

it('NFR-MNT-03: the five ids a regex literal used to hide read as covered', () => {
  const named = idsNamedByTests(['__tests__', 'e2e']);
  for (const id of ['FR-ACC-04', 'FR-DEC-06', 'FR-MEM-04', 'FR-MEM-05', 'FR-PRJ-03']) expect(named.has(id), id).toBe(true);
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
  // The output is matched as text, so any escape that arrives (CI colours a child's output) is removed first.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ['scripts/requirements/must-ids.mjs', ...args], { encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout.replace(ansi, ''), stderr: r.stderr.replace(ansi, '') };
  };
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
