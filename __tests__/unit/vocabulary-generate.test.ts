import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emitIds, emitTerms, findSource, generate, parseSection2, serialise, splitRetire, VocabularyError,
} from '../../scripts/vocabulary/generate.mjs';
import * as terms from '@/lib/vocabulary/terms';
import { VOCABULARY_IDS } from '@/lib/vocabulary/ids';
import { verbatim } from '@/lib/vocabulary/verbatim';

/**
 * Plan 1A, Task 7. The vocabulary is generated from CONSOLIDATED section 2, which lives outside the repository. A test
 * that needs that file says "(needs the source file)" and is skipped when it is absent (CI); the same properties are
 * asserted on the committed data/vocabulary.json, which CI does have.
 */

const read = (p: string) => readFileSync(p, 'utf8');
const SOURCE = findSource();
const OVERRIDES = JSON.parse(read('scripts/vocabulary/overrides.json'));
const RULES = JSON.parse(read('scripts/vocabulary/lint-rules.json'));
const COMMITTED = JSON.parse(read('data/vocabulary.json'));
type Concept = { id: string; term: string; definition: string | null; defineOnFirstUse: boolean; historical?: true;
  retired: Array<{ text: string; lint?: string }>; concept: string; group: string };
const byId = (id: string) => {
  const c = (COMMITTED.concepts as Concept[]).find((x) => x.id === id);
  if (!c) throw new Error(`no concept ${id}`);
  return c;
};

/** A rule for every retired item the parse yields, so a fresh generation needs no flag. */
function completeRules(markdown: string) {
  const rules: Record<string, Record<string, unknown>> = {};
  for (const row of parseSection2(markdown)) {
    const items = splitRetire(row.retire);
    if (items.length) rules[row.id] = Object.fromEntries(items.map((t: string) => [t, { lint: 'review', why: 'fixture' }]));
  }
  for (const [id, texts] of Object.entries(OVERRIDES.retired.add as Record<string, string[]>)) {
    rules[id] = { ...(rules[id] ?? {}), ...Object.fromEntries(texts.map((t) => [t, { lint: 'review', why: 'fixture' }])) };
  }
  return rules;
}

const ROW = (concept: string, ruled: string, def = 'A definition.', retire = 'n/a') =>
  `| ${concept} | forms | ${ruled} | ${def} | ${retire} |`;
const FIXTURE_MD = (rows: string[]) => [
  '## 2. The vocabulary', '', '### Group one', '', '| Concept | Forms in use | Ruled term | Definition | Retire |',
  '|---|---|---|---|---|', ...rows, '', '### Terms the owner must decide', '',
].join('\n');
const NO_OVERRIDES = { terms: { spec: {}, extract: {}, whole: {}, fromConcept: {} }, definitions: {}, retired: { add: {} }, additions: [], historical: [], defineOnFirstUse: [] };
const fails = (fn: () => unknown, ...needles: string[]) => {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(VocabularyError);
  for (const n of needles) expect((err as Error).message).toContain(n);
};

describe('the committed vocabulary (no source needed)', () => {
  it('spec 6: 115 concepts (114 rows plus legal-name), ids unique, legal-name and the historical flag present', () => {
    const ids = (COMMITTED.concepts as Concept[]).map((c) => c.id);
    expect(ids).toHaveLength(115);
    expect(new Set(ids).size).toBe(115);
    expect(byId('legal-name').term).toBe('legal name');
    expect(byId('organisation-agreement').historical).toBe(true);
    expect(byId('organisation-agreement-record-of-signing').historical).toBe(true);
    expect((COMMITTED.concepts as Concept[]).filter((c) => c.historical).map((c) => c.id).sort())
      .toEqual(['organisation-agreement', 'organisation-agreement-record-of-signing']);
  });

  it('definitions are at most 20 words, as CONSOLIDATED requires', () => {
    for (const c of COMMITTED.concepts as Concept[]) {
      if (c.definition) expect(c.definition.split(/\s+/).length, c.id).toBeLessThanOrEqual(20);
    }
  });

  it('overrides apply: dashboard is Home; the stages keep their names (D1)', () => {
    expect(byId('dashboard').term).toBe('Home');
    expect(byId('dashboard').definition).toBe('Your starting page in this organisation: your next step and what is open.');
    expect(byId('dashboard').retired.map((r) => r.text)).toEqual(['Dashboard']);
    expect(byId('stage-1').term).toBe('Pre-processing');
    expect(byId('stage-2').term).toBe('In-processing');
    expect(byId('stage-3').term).toBe('Post-processing');
  });

  it('no term carries a usage note: the L2-1 map is applied', () => {
    expect(byId('question').term).toBe('question');
    expect(byId('product').term).toBe('MAK-AI RAI Platform');
    expect(byId('mitigation-status').term).toBe('mitigation status');
    expect(byId('check-again-date').term).toBe('Check again on {date}');
    for (const [id, t] of Object.entries(OVERRIDES.terms.extract as Record<string, string>)) expect(byId(id).term, id).toBe(t);
    for (const id of ['account-type-admin-screen', 'archive-a-project', 'accepted-risk', 'stage-review']) expect(byId(id).term).not.toMatch(/[:(")]/);
  });

  it('exactly the ids listed under defineOnFirstUse are true; plain words are false', () => {
    const listed: string[] = OVERRIDES.defineOnFirstUse;
    expect(listed).toHaveLength(26);
    const trues = (COMMITTED.concepts as Concept[]).filter((c) => c.defineOnFirstUse).map((c) => c.id).sort();
    expect(trues).toEqual([...listed].sort());
    for (const id of ['project', 'organisation', 'question', 'decision', 'member', 'team', 'download-all-records-team-export']) {
      expect(byId(id).defineOnFirstUse, id).toBe(false);
    }
    for (const id of listed) expect(byId(id).definition, id).not.toBeNull();
  });

  it('n/a definitions are null and n/a retirements are empty (L2-2)', () => {
    expect(byId('team').definition).toBeNull();
    expect(byId('control-types').retired).toEqual([]);
    expect(byId('finding').retired.map((r) => r.text)).toEqual(['shortfall', 'issue']);
  });

  it('retired items follow the split rule: outside parentheses, quotes and backticks', () => {
    expect(splitRetire('issue (for invitations), revoke')).toEqual(['issue (for invitations)', 'revoke']);
    expect(splitRetire('Explore; do not use "Reference" (it already means support reference and request reference)'))
      .toEqual(['Explore', 'do not use "Reference" (it already means support reference and request reference)']);
    expect(splitRetire('"Not applicable (scope answer: no)"')).toEqual(['Not applicable (scope answer: no)']);
    expect(splitRetire('draft, "on this device", "saved on this device"')).toEqual(['draft', 'on this device', 'saved on this device']);
    expect(splitRetire('"team" as a page or account name')).toEqual(['"team" as a page or account name']);
    expect(splitRetire('a `x, y` b, c')).toEqual(['a `x, y` b', 'c']);
    expect(splitRetire('n/a')).toEqual([]);
    expect(splitRetire('n/a (D EX21; owner to confirm against the controls)')).toEqual([]);
  });

  it('the committed ids.ts and terms.ts equal a fresh emit from the committed JSON', () => {
    expect(read('lib/vocabulary/ids.ts')).toBe(emitIds(COMMITTED));
    expect(read('lib/vocabulary/terms.ts')).toBe(emitTerms(COMMITTED));
    expect(VOCABULARY_IDS).toEqual(COMMITTED.concepts.map((c: Concept) => c.id));
    expect(terms.TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION.id).toBe('personal-data-question-scope-question');
    expect(terms.TERM_FINDING).toEqual({ id: 'finding', term: 'finding', definition: byId('finding').definition, defineOnFirstUse: true });
  });

  it('properNames: one entry per unique resource title of the running content, first occurrence, file order', () => {
    const running = JSON.parse(read('data/content/index.json')).running;
    const file = `data/content/${running}/assessmentAreas.json`;
    const areas = JSON.parse(read(file));
    const titles: string[] = [];
    for (const c of areas.controls) for (const r of c.resources ?? []) if (!titles.includes(r.title)) titles.push(r.title);
    expect(COMMITTED.properNames.map((p: { text: string }) => p.text)).toEqual(titles);
    expect(COMMITTED.properNames.length).toBe(70);
    expect(COMMITTED.properNames[0].source).toBe(`${file}:controls[0].resources[0].title`);
  });

  it('the generated JSON carries the plan source path, never an absolute path or a home directory', () => {
    expect(COMMITTED.source).toBe('records/plans/2026-11-11-ux-redesign/copy-audit/CONSOLIDATED.md');
    expect(COMMITTED.overrides).toBe('scripts/vocabulary/overrides.json');
    expect(COMMITTED.lintRules).toBe('scripts/vocabulary/lint-rules.json');
    expect(JSON.stringify(COMMITTED)).not.toMatch(/\/home\/|[A-Za-z]:\\/);
    expect(read('data/vocabulary.json')).toMatch(/^\{\n {2}"_generated": "Generated; do not edit by hand\./);
    expect(read('lib/vocabulary/ids.ts')).toMatch(/^\/\/ Generated; do not edit by hand\. Command: node scripts\/vocabulary\/generate\.mjs/);
    expect(read('lib/vocabulary/terms.ts')).toMatch(/^\/\/ Generated; do not edit by hand\. Command: node scripts\/vocabulary\/generate\.mjs/);
    expect(read('data/vocabulary.json').endsWith('}\n')).toBe(true);
  });

  it('verbatim returns the text unchanged', () => {
    expect(verbatim('legal-text', 'Terms of Service — v1')).toBe('Terms of Service — v1');
    expect(verbatim('giz-credit', '')).toBe('');
  });
});

describe('the generator, on fixtures (no source needed)', () => {
  const opts = { allowMissingRules: true, properNames: [] };
  const gen = (rows: string[], overrides: unknown = NO_OVERRIDES, rules: unknown = {}, o: { allowMissingRules?: boolean; properNames: never[] } = opts) =>
    generate(FIXTURE_MD(rows), overrides, rules, o);

  it('parses 5-cell rows, strips **[owner]**, keeps parenthesised qualifiers in the id', () => {
    const v = gen([ROW('Finding **[owner]**', 'finding'), ROW('Unsaved changes (draft)', 'unsaved')], { ...NO_OVERRIDES });
    expect(v.concepts.map((c: Concept) => c.id)).toEqual(['finding', 'unsaved-changes-draft']);
    expect(v.concepts[0]).toMatchObject({ group: 'Group one', concept: 'Finding', ownerDecision: true });
    expect(v.concepts[1]).toMatchObject({ ownerDecision: false });
  });

  it('is deterministic: the same input gives the same bytes', () => {
    const a = serialise(gen([ROW('A', 'a'), ROW('B', 'b')]));
    expect(serialise(gen([ROW('A', 'a'), ROW('B', 'b')]))).toBe(a);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).not.toContain('\r');
  });

  it('exits 2 (throws) when a retired item has no lint rule, naming the id and the item', () => {
    fails(() => gen([ROW('Dash', 'dash', 'd', 'foo, bar')], NO_OVERRIDES, {}, { properNames: [] }), 'dash', 'foo');
  });

  it('with the flag, an item with no rule is written with text only; a rule is merged by id and text', () => {
    const v = gen([ROW('Dash', 'dash', 'd', 'foo, bar')], NO_OVERRIDES, { dash: { bar: { lint: 'phrase', pattern: '\\bbar\\b', caseSensitive: false } } });
    expect(v.concepts[0].retired).toEqual([{ text: 'foo' }, { text: 'bar', lint: 'phrase', pattern: '\\bbar\\b', caseSensitive: false }]);
  });

  it('exits 2 when a rule names an unknown id or a text the row does not retire', () => {
    fails(() => gen([ROW('Dash', 'dash', 'd', 'foo')], NO_OVERRIDES, { ghost: { x: { lint: 'review', why: 'w' } } }), 'ghost');
    fails(() => gen([ROW('Dash', 'dash', 'd', 'foo')], NO_OVERRIDES, { dash: { nope: { lint: 'review', why: 'w' } } }), 'dash', 'nope');
  });

  it('exits 2 when an override names an unknown id, in every override list', () => {
    const base = (patch: Record<string, unknown>) => ({ ...NO_OVERRIDES, ...patch });
    const rows = [ROW('Dash', 'dash')];
    fails(() => gen(rows, base({ terms: { ...NO_OVERRIDES.terms, spec: { ghost: 'x' } } })), 'ghost');
    fails(() => gen(rows, base({ terms: { ...NO_OVERRIDES.terms, extract: { ghost: 'x' } } })), 'ghost');
    fails(() => gen(rows, base({ terms: { ...NO_OVERRIDES.terms, whole: { ghost: 'x' } } })), 'ghost');
    fails(() => gen(rows, base({ terms: { ...NO_OVERRIDES.terms, fromConcept: { ghost: 'x' } } })), 'ghost');
    fails(() => gen(rows, base({ definitions: { ghost: 'x' } })), 'ghost');
    fails(() => gen(rows, base({ retired: { add: { ghost: ['x'] } } })), 'ghost');
    fails(() => gen(rows, base({ historical: ['ghost'] })), 'ghost');
    fails(() => gen(rows, base({ defineOnFirstUse: ['ghost'] })), 'ghost');
  });

  it('exits 2 when an addition clashes with a parsed id, and appends additions after the rows', () => {
    const add = { id: 'dash', group: 'g', concept: 'Dash', term: 'dash', definition: 'x', retired: [], defineOnFirstUse: false, source: 's' };
    fails(() => gen([ROW('Dash', 'dash')], { ...NO_OVERRIDES, additions: [add] }), 'dash');
    const v = gen([ROW('Dash', 'dash')], { ...NO_OVERRIDES, additions: [{ ...add, id: 'extra' }] });
    expect(v.concepts.map((c: Concept) => c.id)).toEqual(['dash', 'extra']);
  });

  it('exits 2 when a defineOnFirstUse id has a null definition', () => {
    fails(() => gen([ROW('Team', 'team', 'n/a (plain word)')], { ...NO_OVERRIDES, defineOnFirstUse: ['team'] }), 'team');
  });

  it('the guard: a Ruled-term cell with ; : ( or " and no term override exits 2, naming the id and the cell', () => {
    for (const cell of ['one; two', 'Account type: x', 'term (note)', 'say "this"']) {
      fails(() => gen([ROW('Guarded', cell)]), 'guarded', cell);
    }
    // any kind of term override lifts the guard
    const lifted = gen([ROW('Guarded', 'term (note)')], { ...NO_OVERRIDES, terms: { ...NO_OVERRIDES.terms, extract: { guarded: 'term' } } });
    expect(lifted.concepts[0].term).toBe('term');
    const spec = gen([ROW('Guarded', 'term (note)')], { ...NO_OVERRIDES, terms: { ...NO_OVERRIDES.terms, spec: { guarded: 'Spec' } } });
    expect(spec.concepts[0].term).toBe('Spec');
  });

  it('exits 2 when a term override is not what its kind says', () => {
    const t = (kind: string, v: string) => ({ ...NO_OVERRIDES, terms: { ...NO_OVERRIDES.terms, [kind]: { guarded: v } } });
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('extract', 'zzz')), 'guarded', 'zzz');
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('whole', 'abc')), 'guarded');
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('fromConcept', 'nope')), 'guarded');
    expect(gen([ROW('Guarded', 'abc (d)')], t('whole', 'abc (d)')).concepts[0].term).toBe('abc (d)');
    expect(gen([ROW('Guarded', 'abc (d)')], t('fromConcept', 'guarded')).concepts[0].term).toBe('guarded');
  });

  it('exits 2 on a row that does not have five cells, or a duplicate id', () => {
    fails(() => generate(FIXTURE_MD(['| A | b | c | d |']), NO_OVERRIDES, {}, opts), 'A');
    fails(() => gen([ROW('Same', 'a'), ROW('Same', 'b')]), 'same');
  });

  it('runs as a process: exit code 2 and a message naming the id when an override id is unknown; nothing is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      const md = join(dir, 'c.md');
      writeFileSync(md, FIXTURE_MD([ROW('Dash', 'dash')]));
      const r = spawnSync(process.execPath, ['scripts/vocabulary/generate.mjs', md, '--allow-missing-rules', '--out-dir', dir], { encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('dashboard');
      expect(existsSync(join(dir, 'data/vocabulary.json'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('against the source file', () => {
  const src = () => read(SOURCE as string);

  it.skipIf(!SOURCE)('one concept per CONSOLIDATED section 2 row (114) plus overrides.additions (1): 115, ids unique (needs the source file)', () => {
    const rows = parseSection2(src());
    expect(rows).toHaveLength(114);
    expect(new Set(rows.map((r: { id: string }) => r.id)).size).toBe(114);
    const v = generate(src(), OVERRIDES, completeRules(src()), { properNames: COMMITTED.properNames });
    expect(v.concepts).toHaveLength(115);
    expect(new Set(v.concepts.map((c: Concept) => c.id)).size).toBe(115);
  });

  it.skipIf(!SOURCE)('the committed files equal a fresh generation, and the recorded hash is the source hash (needs the source file)', () => {
    const v = generate(src(), OVERRIDES, RULES, { allowMissingRules: true, properNames: COMMITTED.properNames });
    expect(read('data/vocabulary.json')).toBe(serialise(v));
    expect(read('lib/vocabulary/terms.ts')).toBe(emitTerms(v));
    expect(read('lib/vocabulary/ids.ts')).toBe(emitIds(v));
    expect(COMMITTED.sourceSha256).toBe(createHash('sha256').update(readFileSync(SOURCE as string)).digest('hex'));
  });

  it.skipIf(!SOURCE)('term overrides: an extraction is a substring of its cell, a whole entry equals its cell, a concept entry is the Concept column lower-cased (needs the source file)', () => {
    const rows = new Map<string, { ruled: string; concept: string }>(parseSection2(src()).map((r: { id: string; ruled: string; concept: string }) => [r.id, r]));
    const T = OVERRIDES.terms as Record<'extract' | 'whole' | 'fromConcept', Record<string, string>>;
    expect(Object.keys(T.extract)).toHaveLength(30);
    expect(Object.keys(T.whole)).toHaveLength(3);
    expect(Object.keys(T.fromConcept)).toHaveLength(3);
    for (const [id, t] of Object.entries(T.extract)) expect(rows.get(id)!.ruled, id).toContain(t);
    for (const [id, t] of Object.entries(T.whole)) expect(rows.get(id)!.ruled, id).toBe(t);
    for (const [id, t] of Object.entries(T.fromConcept)) expect(rows.get(id)!.concept.toLowerCase(), id).toBe(t);
  });

  it.skipIf(!SOURCE)('every other Ruled-term cell is the term as written, and none has a guard character without an override (needs the source file)', () => {
    const T = OVERRIDES.terms as Record<string, Record<string, string>>;
    const overridden = new Set(Object.values(T).flatMap((m) => Object.keys(m)));
    for (const r of parseSection2(src()) as Array<{ id: string; ruled: string }>) {
      if (overridden.has(r.id)) continue;
      expect(r.ruled, r.id).not.toMatch(/[;:("]/);
      expect(byId(r.id).term, r.id).toBe(r.ruled);
    }
  });

  it.skipIf(!SOURCE)('runs as a process: exit code 0 and the committed bytes (needs the source file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      const r = spawnSync(process.execPath, ['scripts/vocabulary/generate.mjs', SOURCE as string, '--allow-missing-rules', '--out-dir', dir], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(read(join(dir, 'data/vocabulary.json'))).toBe(read('data/vocabulary.json'));
      expect(read(join(dir, 'lib/vocabulary/terms.ts'))).toBe(read('lib/vocabulary/terms.ts'));
      expect(read(join(dir, 'lib/vocabulary/ids.ts'))).toBe(read('lib/vocabulary/ids.ts'));
      const missing = spawnSync(process.execPath, ['scripts/vocabulary/generate.mjs', SOURCE as string, '--out-dir', dir], { encoding: 'utf8' });
      expect(missing.status).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
