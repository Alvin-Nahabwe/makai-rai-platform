import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emitIds, emitTerms, findSource, generate, parseSection2, readProperNames, serialise, SOURCE_RELATIVE, splitRetire, VocabularyError,
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
const NO_OVERRIDES = { terms: { spec: {}, extract: {}, labels: {}, fromConcept: {} }, definitions: {}, retired: { add: {} }, additions: [], historical: [], defineOnFirstUse: [] };
/** Plan line 281, as a literal: the product terms a new reader would not know. */
const PLAN_DEFINE_ON_FIRST_USE = [
  'finding', 'mitigation', 'accepted-risk', 'stage-review', 'seal', 'control', 'risk-area', 'fingerprint',
  'version-of-a-decision', 'stage-1', 'stage-2', 'stage-3', 'done', 'partly', 'not-yet', 'not-applicable',
  'does-not-apply', 'personal-data-question-scope-question', 'data-card', 'model-card', 'mitigation-plan',
  'owner', 'admin', 'assessor', 'reviewer', 'viewer',
];
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

  it('no term carries a usage note: none holds ( " or :, and a ; only where terms.labels says so', () => {
    const labelled = new Set(Object.keys(OVERRIDES.terms.labels));
    for (const c of COMMITTED.concepts as Concept[]) {
      expect(c.term, c.id).not.toMatch(/[(":]/);
      if (c.term.includes(';')) expect(labelled.has(c.id), c.id).toBe(true);
    }
    for (const [id, labels] of Object.entries(OVERRIDES.terms.labels as Record<string, string[]>)) expect(byId(id).term).toBe(labels.join('; '));
    expect(byId('follow-up-list').term).toBe('Mitigations assigned to me; Mitigations to follow up');
  });

  it('exactly the ids listed under defineOnFirstUse are true; plain words are false', () => {
    const listed: string[] = PLAN_DEFINE_ON_FIRST_USE;
    expect(OVERRIDES.defineOnFirstUse).toEqual(listed);
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
    fails(() => gen(rows, base({ terms: { ...NO_OVERRIDES.terms, labels: { ghost: ['x'] } } })), 'ghost');
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
    const t = (kind: string, v: string | string[]) => ({ ...NO_OVERRIDES, terms: { ...NO_OVERRIDES.terms, [kind]: { guarded: v } } });
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('extract', 'zzz')), 'guarded', 'zzz');
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('labels', ['zzz'])), 'guarded', 'zzz');
    fails(() => gen([ROW('Guarded', 'abc (d)')], t('fromConcept', 'nope')), 'guarded');
    expect(gen([ROW('Guarded', 'abc; def (d)')], t('labels', ['abc', 'def'])).concepts[0].term).toBe('abc; def');
    expect(gen([ROW('Guarded', 'abc (d)')], t('fromConcept', 'guarded')).concepts[0].term).toBe('guarded');
  });

  it('exits 2 on a row that does not have five cells, or a duplicate id', () => {
    fails(() => generate(FIXTURE_MD(['| A | b | c | d |']), NO_OVERRIDES, {}, opts), 'has 4 cells');
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

  it.skipIf(!SOURCE)('term overrides: an extraction is a substring of its cell, a label is an extraction of the cell and the term joins them, a concept entry is the Concept column lower-cased (needs the source file)', () => {
    const rows = new Map<string, { ruled: string; concept: string }>(parseSection2(src()).map((r: { id: string; ruled: string; concept: string }) => [r.id, r]));
    const T = OVERRIDES.terms as Record<'extract' | 'fromConcept', Record<string, string>> & { labels: Record<string, string[]> };
    expect(Object.keys(T.extract)).toHaveLength(30);
    expect(Object.keys(T.labels)).toHaveLength(3);
    expect(Object.keys(T.fromConcept)).toHaveLength(3);
    for (const [id, t] of Object.entries(T.extract)) expect(rows.get(id)!.ruled, id).toContain(t);
    for (const [id, ls] of Object.entries(T.labels)) for (const l of ls) expect(rows.get(id)!.ruled, id).toContain(l);
    for (const [id, t] of Object.entries(T.fromConcept)) expect(rows.get(id)!.concept.toLowerCase(), id).toBe(t);
  });

  it.skipIf(!SOURCE)('every other Ruled-term cell is the term as written, and none has a guard character without an override (needs the source file)', () => {
    const T = OVERRIDES.terms as Record<string, Record<string, unknown>>;
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
      expect(missing.stderr).toContain('Toolkit');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the source file is found (L2-3a)', () => {
  it('CONSOLIDATED.md is found, or CI is set; otherwise this fails and says where it is expected', () => {
    expect(
      SOURCE !== undefined || Boolean(process.env.CI),
      `CONSOLIDATED.md not found. It is expected at <a parent of the repository, up to four levels up>/${SOURCE_RELATIVE}; set VOCABULARY_SOURCE to its path. The source-reading tests are skipped only when CI is set.`,
    ).toBe(true);
  });

  it('VOCABULARY_SOURCE that is empty, missing or not a regular file throws', () => {
    const keep = process.env.VOCABULARY_SOURCE;
    try {
      for (const bad of ['', join(tmpdir(), 'no-such-vocabulary-file.md'), tmpdir()]) {
        process.env.VOCABULARY_SOURCE = bad;
        expect(() => findSource(), JSON.stringify(bad)).toThrow(VocabularyError);
      }
    } finally {
      if (keep === undefined) delete process.env.VOCABULARY_SOURCE; else process.env.VOCABULARY_SOURCE = keep;
    }
  });
});

describe('overrides.json and the committed JSON agree (no source needed)', () => {
  it('every entry of every override map is in data/vocabulary.json', () => {
    const O = OVERRIDES;
    for (const [id, t] of Object.entries({ ...O.terms.spec, ...O.terms.extract, ...O.terms.fromConcept } as Record<string, string>)) expect(byId(id).term, id).toBe(t);
    for (const [id, ls] of Object.entries(O.terms.labels as Record<string, string[]>)) expect(byId(id).term, id).toBe(ls.join('; '));
    for (const [id, d] of Object.entries(O.definitions as Record<string, string | null>)) expect(byId(id).definition, id).toBe(d);
    for (const [id, texts] of Object.entries(O.retired.add as Record<string, string[]>)) {
      for (const t of texts) expect(byId(id).retired.map((r) => r.text), id).toContain(t);
    }
    for (const a of O.additions) expect(byId(a.id)).toMatchObject({ group: a.group, concept: a.concept, term: a.term, definition: a.definition, source: a.source, retired: [] });
    for (const id of O.historical) expect(byId(id).historical, id).toBe(true);
    expect((COMMITTED.concepts as Concept[]).filter((c) => c.definition === null)).toHaveLength(16);
    expect(byId('organisation-agreement-record-of-signing').definition).toBeNull();
  });
});

describe('overrides: key presence decides, and nothing is inherited (fix A)', () => {
  const gen = (rows: string[], overrides: unknown = NO_OVERRIDES, rules: unknown = {}) =>
    generate(FIXTURE_MD(rows), overrides, rules, { allowMissingRules: true, properNames: [] });
  const withDef = (definitions: unknown) => ({ ...NO_OVERRIDES, definitions });

  it('a null definition override wins over the cell; only a non-empty string or null is accepted', () => {
    expect(gen([ROW('Dash', 'dash', 'See somewhere.')], withDef({ dash: null })).concepts[0].definition).toBeNull();
    expect(gen([ROW('Dash', 'dash', 'See somewhere.')], withDef({ dash: 'Own text.' })).concepts[0].definition).toBe('Own text.');
    for (const bad of ['', 7, undefined, {}]) fails(() => gen([ROW('Dash', 'dash')], withDef({ dash: bad })), 'dash');
  });

  it('a concept called constructor, or an item called toString, finds no inherited property', () => {
    const v = gen([ROW('Constructor', 'constructor', 'A definition.', 'toString')]);
    expect(v.concepts[0]).toMatchObject({ id: 'constructor', definition: 'A definition.', retired: [{ text: 'toString' }] });
    const w = gen([ROW('Constructor', 'constructor', 'A definition.', 'toString')], NO_OVERRIDES, {});
    expect(w.concepts[0].retired).toEqual([{ text: 'toString' }]);
    fails(() => generate(FIXTURE_MD([ROW('Constructor', 'constructor', 'A definition.', 'toString')]), NO_OVERRIDES, {}, { properNames: [] }), 'constructor', 'toString');
  });
});

describe('the generator rejects a changed source loudly (fix D)', () => {
  const HEADER = '| Concept | Forms in use (one example each) | Ruled term | Definition (shown at first use) | Retire |';
  const md = (body: string[]) => ['## 2. The vocabulary', '', '### G', '', ...body, '', '### Terms the owner must decide', ''].join('\n');
  const SEP = '|---|---|---|---|---|';
  const run = (body: string[]) => parseSection2(md(body));

  it('an indented table row is a row', () => {
    expect(run([HEADER, SEP, `  ${ROW('Dash', 'dash')}`]).map((r: { id: string }) => r.id)).toEqual(['dash']);
  });

  it('a header that is not the five exact column names exits 2; only the exact header is skipped', () => {
    fails(() => run(['| Concept | Forms | Ruled term | Definition | Retire |', SEP, ROW('Dash', 'dash')]), 'header');
    expect(run([HEADER, SEP, ROW('Dash', 'dash')])).toHaveLength(1);
    // the other seven tables of the source use the short names
    expect(run(['| Concept | Forms in use | Ruled term | Definition | Retire |', SEP, ROW('Dash', 'dash')])).toHaveLength(1);
    fails(() => run(['| Concept | Forms in use | Ruled term | Definition |', SEP, ROW('Dash', 'dash')]), 'header');
  });

  it('a data row whose concept is "Concept" is a row', () => {
    expect(run([HEADER, SEP, ROW('Concept', 'concept')]).map((r: { id: string }) => r.id)).toEqual(['concept']);
  });

  it('a heading that is not ### exits 2', () => {
    fails(() => run(['#### Sub', HEADER, SEP, ROW('Dash', 'dash')]), '####');
    fails(() => run(['## Other', HEADER, SEP, ROW('Dash', 'dash')]), '## Other');
  });

  it('an empty Concept, Ruled-term or Definition cell exits 2', () => {
    fails(() => run([HEADER, SEP, ROW('', 'dash')]), 'Concept');
    fails(() => run([HEADER, SEP, ROW('Dash', '')]), 'dash', 'Ruled');
    fails(() => run([HEADER, SEP, ROW('Dash', 'dash', '')]), 'dash', 'Definition');
  });

  it('n/a is matched without regard to case', () => {
    expect(splitRetire('N/A')).toEqual([]);
    expect(splitRetire('N/a (x)')).toEqual([]);
    const v = generate(md([HEADER, SEP, ROW('Dash', 'dash', 'N/A (plain word)')]), NO_OVERRIDES, {}, { properNames: [] });
    expect(v.concepts[0].definition).toBeNull();
  });

  it('a retired cell that ends inside an open quote, parenthesis or backtick exits 2', () => {
    for (const cell of ['a, "b, c', 'a, (b, c', 'a, `b, c']) fails(() => splitRetire(cell), cell);
    fails(() => generate(md([HEADER, SEP, ROW('Dash', 'dash', 'd', 'a, (b, c')]), NO_OVERRIDES, {}, { allowMissingRules: true, properNames: [] }), 'dash');
  });
});

describe('merged concepts are validated in one place (fix E)', () => {
  const gen = (rows: string[], overrides: Record<string, unknown> = {}, rules: unknown = {}) =>
    generate(FIXTURE_MD(rows), { ...NO_OVERRIDES, ...overrides }, rules, { allowMissingRules: true, properNames: [] });
  const add = { id: 'extra', group: 'g', concept: 'Extra', term: 'extra', definition: 'x', retired: [], defineOnFirstUse: false, source: 's' };

  it('an id that is not kebab case exits 2, naming the id', () => {
    fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, id: 'Bad_Id' }] }), 'Bad_Id');
    fails(() => gen([ROW('!!!', 'dash')]), 'concept');
  });

  it('an empty group, concept or term exits 2, naming the id', () => {
    for (const key of ['group', 'concept', 'term']) fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, [key]: '' }] }), 'extra', key);
  });

  it('a definition over 20 words, or an empty one, exits 2, naming the id', () => {
    const long = Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ');
    fails(() => gen([ROW('Dash', 'dash', long)]), 'dash');
    fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, definition: '' }] }), 'extra');
    expect(gen([ROW('Dash', 'dash', long.split(' ').slice(0, 20).join(' '))]).concepts).toHaveLength(1);
  });

  it('a defineOnFirstUse id needs a non-empty string definition', () => {
    fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, definition: undefined, defineOnFirstUse: true }], defineOnFirstUse: ['extra'] }), 'extra');
    fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, definition: '', defineOnFirstUse: true }], defineOnFirstUse: ['extra'] }), 'extra');
  });

  it('an unknown key in overrides.json, at any level, exits 2 naming the key; a missing optional key is fine', () => {
    fails(() => gen([ROW('Dash', 'dash')], { definiton: {} }), 'definiton');
    fails(() => gen([ROW('Dash', 'dash')], { terms: { ...NO_OVERRIDES.terms, whoel: {} } }), 'whoel');
    fails(() => gen([ROW('Dash', 'dash')], { retired: { add: {}, remove: {} } }), 'remove');
    fails(() => gen([ROW('Dash', 'dash')], { additions: [{ ...add, sauce: 'x' }] }), 'sauce');
    const bare = generate(FIXTURE_MD([ROW('Dash', 'dash')]), {}, {}, { properNames: [] });
    expect(bare.concepts).toHaveLength(1);
  });

  it('an unknown key in a lint rule exits 2 naming the key', () => {
    fails(() => gen([ROW('Dash', 'dash', 'd', 'foo')], {}, { dash: { foo: { lint: 'review', why: 'w', wyh: 'x' } } }), 'wyh');
    fails(() => gen([ROW('Dash', 'dash', 'd', 'foo')], {}, { dash: { foo: { lint: 'phrase', pattern: 'p', caseSensitive: true, why: 'x' } } }), 'why');
  });

  it('a resource with no non-empty title exits 2; a missing or invalid content file exits 2 naming the path', () => {
    const root = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      mkdirSync(join(root, 'data/content/9.9.9'), { recursive: true });
      writeFileSync(join(root, 'data/content/index.json'), JSON.stringify({ running: '9.9.9' }));
      const areas = join(root, 'data/content/9.9.9/assessmentAreas.json');
      writeFileSync(areas, JSON.stringify({ controls: [{ id: 'C-1', resources: [{ title: 'Fine' }, { title: '' }] }] }));
      fails(() => readProperNames(root), 'controls[0].resources[1]');
      writeFileSync(areas, '{ not json');
      fails(() => readProperNames(root), 'assessmentAreas.json');
      rmSync(areas);
      fails(() => readProperNames(root), 'assessmentAreas.json');
      writeFileSync(areas, JSON.stringify({ controls: [{ id: 'C-1', resources: [{ title: 'Fine' }, { title: 'Fine' }] }] }));
      expect(readProperNames(root)).toEqual([{ text: 'Fine', source: 'data/content/9.9.9/assessmentAreas.json:controls[0].resources[0].title' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the command line is strict (fix C) and reports errors as exit 2 (fix F)', () => {
  const script = join(process.cwd(), 'scripts/vocabulary/generate.mjs');
  const files = ['data/vocabulary.json', 'lib/vocabulary/ids.ts', 'lib/vocabulary/terms.ts'];
  const stamps = () => files.map((f) => statSync(f).mtimeMs);

  function runIn(args: string[], extra?: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      writeFileSync(join(dir, 'c.md'), FIXTURE_MD([ROW('Dash', 'dash')]));
      extra?.(dir);
      const before = stamps();
      const r = spawnSync(process.execPath, [script, ...args.map((a) => a.replace('<md>', join(dir, 'c.md')))], { encoding: 'utf8', cwd: dir });
      expect(stamps(), 'the repository files were not touched').toEqual(before);
      const written = readdirSync(dir).filter((f) => f !== 'c.md' && f !== 'link.mjs');
      return { r, written };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const cases: Array<[string, string[], string]> = [
    ['--out-dir=/x', ['<md>', '--out-dir=/x'], '--out-dir=/x'],
    ['--out-dir with no value', ['<md>', '--out-dir'], '--out-dir'],
    ['--out-dir followed by a flag', ['<md>', '--out-dir', '--allow-missing-rules'], '--out-dir'],
    ['an unknown flag', ['<md>', '--frobnicate'], '--frobnicate'],
    ['a second positional argument', ['<md>', 'second.md'], 'second.md'],
  ];
  for (const [title, args, needle] of cases) {
    it(`${title}: exit 2, stderr names it, nothing is written`, () => {
      const { r, written } = runIn(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(needle);
      expect(written).toEqual([]);
    });
  }

  it('a missing source file exits 2 with "vocabulary: <path>: <reason>", not a stack trace', () => {
    const { r } = runIn(['/no/such/dir/c.md']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^vocabulary: \/no\/such\/dir\/c\.md: /);
    expect(r.stderr).not.toContain('    at ');
  });

  it('runs through a symlinked path (the entry-point check compares real paths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      symlinkSync(script, join(dir, 'link.mjs'));
      writeFileSync(join(dir, 'c.md'), FIXTURE_MD([ROW('Dash', 'dash')]));
      const viaLink = spawnSync(process.execPath, [join(dir, 'link.mjs'), join(dir, 'c.md'), '--allow-missing-rules', '--out-dir', dir], { encoding: 'utf8' });
      expect(viaLink.status).toBe(2);
      expect(viaLink.stderr).toContain('dashboard');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the table structure is checked, not counted (fix round 2, item 1)', () => {
  const HEADER = '| Concept | Forms in use (one example each) | Ruled term | Definition (shown at first use) | Retire |';
  const SHORT_HEADER = '| Concept | Forms in use | Ruled term | Definition | Retire |';
  const SEP = '|---|---|---|---|---|';
  const md = (body: string[]) => ['## 2. The vocabulary', '', '### G', '', ...body, '', '### Terms the owner must decide', ''].join('\n');
  const run = (body: string[]) => parseSection2(md(body));

  it('a row written without its leading pipe exits 2 and the message quotes the line', () => {
    fails(() => run([HEADER, SEP, ROW('A', 'a'), 'B | f | b | d | n/a |']), 'B | f | b | d | n/a |', 'prose');
  });

  it('a row inside a blockquote exits 2 and the message quotes the line', () => {
    fails(() => run([HEADER, SEP, `> ${ROW('B', 'b')}`]), `> ${ROW('B', 'b')}`, 'prose');
  });

  it('a header with no separator after it exits 2, in the first table and in a later one', () => {
    fails(() => run([HEADER, ROW('A', 'a')]), 'separator');
    fails(() => run([HEADER, SEP, ROW('A', 'a'), '', SHORT_HEADER, ROW('B', 'b')]), 'separator');
    fails(() => run([HEADER]), 'separator');
  });

  it('a dashes-only line in the middle of a table exits 2', () => {
    fails(() => run([HEADER, SEP, ROW('A', 'a'), '|---|---|---|---|---|', ROW('B', 'b')]), 'separator');
  });

  it('a table block that starts with a data row exits 2', () => {
    fails(() => run([ROW('A', 'a')]), 'header', ROW('A', 'a'));
    fails(() => run([HEADER, SEP, ROW('A', 'a'), '', ROW('B', 'b')]), 'header', ROW('B', 'b'));
  });

  it('a second header inside a block exits 2', () => {
    fails(() => run([HEADER, SEP, ROW('A', 'a'), SHORT_HEADER, ROW('B', 'b')]), 'second header');
  });

  it('prose without a pipe, and several well-formed blocks, still parse', () => {
    const rows = run([HEADER, SEP, ROW('A', 'a'), '', 'A note with no bar.', '', SHORT_HEADER, SEP, ROW('B', 'b')]);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
  });
});

describe('lint-rules.json of the wrong shape exits 2 (fix round 2, item 2)', () => {
  const gen = (rules: unknown) => generate(FIXTURE_MD([ROW('X', 'x', 'd', 'foo')]), NO_OVERRIDES, rules, { allowMissingRules: true, properNames: [] });

  it('null and an array are not a rules file', () => {
    fails(() => gen(null), 'lint-rules.json', 'object');
    fails(() => gen([]), 'lint-rules.json', 'object');
    fails(() => gen('a'), 'lint-rules.json', 'object');
  });

  it('a concept whose value is not an object keyed by item text names the concept id', () => {
    fails(() => gen({ x: null }), 'lint-rules.json', '"x"');
    fails(() => gen({ x: 'a' }), 'lint-rules.json', '"x"');
    fails(() => gen({ x: [] }), 'lint-rules.json', '"x"');
  });
});

describe('an override map that is present must be an object (fix round 2, item 3)', () => {
  const gen = (overrides: unknown) => generate(FIXTURE_MD([ROW('X', 'x')]), overrides, {}, { allowMissingRules: true, properNames: [] });

  it('definitions: null exits 2 naming the key', () => {
    fails(() => gen({ ...NO_OVERRIDES, definitions: null }), 'definitions');
  });

  it('every other map key given as null exits 2, and so does a list key', () => {
    fails(() => gen({ ...NO_OVERRIDES, terms: { ...NO_OVERRIDES.terms, spec: null } }), 'terms.spec');
    fails(() => gen({ ...NO_OVERRIDES, retired: { add: null } }), 'retired.add');
    fails(() => gen({ ...NO_OVERRIDES, historical: null }), 'historical');
    fails(() => gen({ ...NO_OVERRIDES, defineOnFirstUse: null }), 'defineOnFirstUse');
    fails(() => gen({ ...NO_OVERRIDES, additions: null }), 'additions');
  });

  it('an absent key stays allowed', () => {
    expect(gen({}).concepts).toHaveLength(1);
  });
});

describe('the command line, items 4 and 5 (fix round 2)', () => {
  const script = join(process.cwd(), 'scripts/vocabulary/generate.mjs');

  it('--out-dir with an empty value exits 2 like a missing value and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      writeFileSync(join(dir, 'c.md'), FIXTURE_MD([ROW('Dash', 'dash')]));
      const r = spawnSync(process.execPath, [script, join(dir, 'c.md'), '--out-dir', ''], { encoding: 'utf8', cwd: dir });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--out-dir');
      expect(readdirSync(dir)).toEqual(['c.md']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('importing the module when argv[1] names no file exits 0 and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocab-'));
    try {
      const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(script)})`, 'x'], { encoding: 'utf8', cwd: dir });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
