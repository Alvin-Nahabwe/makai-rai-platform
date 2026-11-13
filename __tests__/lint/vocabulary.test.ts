import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ContentExclusions, contentStrings, CONTENT_FILES, fieldMapTexts, formatHit, lintHtml, lintText, lintTs, notebookTexts,
  phraseRules, PROPER_NAMES, ratchetViolations, readBundle, RULES, RUNNING, scopeContent, scopeCopyModules, scopeEmail,
  scopeFieldMaps, scopeNotebooks, type ScopeResult, type SignedKeys, textBlocks,
  scopeTemplates, type Worklist, worklistOf, writeHits,
} from './helpers/vocabulary-scan';

/**
 * The vocabulary lint (plan 1A, Task 8; design spec section 6, "The vocabulary test"). A retired term of
 * `data/vocabulary.json` whose class is `phrase` may not appear in:
 *   (1) `lib/**\/copy.ts` string and template literals, except inside `verbatim('legal-text' | 'giz-credit', …)`;
 *   (2) the running content bundle's rendered fields (`data/content/<running>/`), signed and unsigned;
 *   (3) `data/fieldmaps/*.json` `label` and `section`;
 *   (4) `lib/email/templates.ts`, `lib/email/templates/*.ts` literals and `ops/host/break-glass-notice.txt`;
 *   (5) `public/templates/*.html` text nodes (report-only until stage 3);
 *   (6) markdown cells of `public/notebooks/*.ipynb` and `notebooks/**\/*.ipynb` (report-only until stage 3).
 * A `review` item is never linted: a reader checks it. The patterns are read from `data/vocabulary.json` (generated
 * from `scripts/vocabulary/lint-rules.json`), so the lint and the generated data cannot disagree.
 * A third-party product name (`properNames`: exact resource titles of the running content) is masked, span by span,
 * before the patterns run, so the rest of the same string is still linted.
 * `data/legal/**` and `data/credit.json` are the quoted texts and are not scanned. There is no allow-list file.
 * With `VOCABULARY_HITS_DIR` set, the hit lists are written there; otherwise the test writes nothing.
 *
 * The worklist (scopes 1, 3 and 4 until Task 20). `__tests__/lint/vocabulary-worklist.json` holds, per file and per
 * "<concept id> :: <item text>", the number of hits each file may still have. A normal test fails when any of them
 * has MORE hits than the file allows (an absent entry allows 0), so a new retired phrase cannot join the worklist
 * unseen. Entries are only ever lowered or removed, never raised; a copy task that removes hits need not touch the
 * file. Task 20 deletes the file together with `.fails`. `VOCABULARY_WORKLIST_PRINT=1` prints the current worklist
 * as JSON for a one-time write by hand; the test never writes the file.
 */

const WORKLIST_FILE = join(__dirname, 'vocabulary-worklist.json');

/** Scopes (1), (3) and (4), scanned once and shared: a normal test forces the scan, so a crash cannot hide in `.fails`. */
let worklistScan: { copy: ScopeResult; fieldMaps: ScopeResult; email: ScopeResult } | undefined;
const scanWorklistScopes = () => (worklistScan ??= { copy: scopeCopyModules(), fieldMaps: scopeFieldMaps(), email: scopeEmail() });
const worklistHits = () => { const s = scanWorklistScopes(); return [...s.copy.hits, ...s.fieldMaps.hits, ...s.email.hits]; };

// ---------------------------------------------------------------------------------------------------------------------

describe('the vocabulary lint, on fixtures', () => {

  it('every phrase rule is proved by examples: each hits its cited forms and passes the correct sentences named for it', () => {
    const examples = JSON.parse(readFileSync(join(__dirname, 'vocabulary-rule-examples.json'), 'utf8')) as
      Record<string, Record<string, { hits: string[]; passes: string[] }>>;
    const problems: string[] = [];
    const phraseItems = new Set<string>();
    for (const rule of RULES) {
      const where = `${rule.id} :: ${rule.item}`;
      phraseItems.add(where);
      const ex = examples[rule.id]?.[rule.item];
      if (!ex || !ex.hits.length) { problems.push(`${where}: no "hits" example`); continue; }
      if (lintText('t', '', [rule], []).length) problems.push(`${where}: matches the empty string`);
      for (const h of ex.hits) if (!lintText('t', h, [rule], []).length) problems.push(`${where}: does not hit ${JSON.stringify(h)}`);
      for (const ok of ex.passes) if (lintText('t', ok, [rule], []).length) problems.push(`${where}: hits the correct ${JSON.stringify(ok)}`);
    }
    for (const [id, byItem] of Object.entries(examples)) {
      for (const item of Object.keys(byItem)) if (!phraseItems.has(`${id} :: ${item}`)) problems.push(`${id} :: ${item}: an example for an item that is not a phrase rule`);
    }
    expect(problems).toEqual([]);
    expect(RULES.length).toBeGreaterThan(70);
  });

  it('an invalid pattern fails at load, naming the concept and the item', () => {
    const bad = { concepts: [{ id: 'x-id', term: 'x', retired: [{ text: 'x item', lint: 'phrase' as const, pattern: '(', caseSensitive: true }] }], properNames: [] };
    expect(() => phraseRules(bad)).toThrow(/x-id.*x item/);
  });

  it('a planted "MAK-AI Responsible AI Toolkit" in a copy module fails, and the message names the term and concept', () => {
    const hits = lintTs('lib/x/copy.ts', "export const X = { title: 'Welcome to the MAK-AI Responsible AI Toolkit' };");
    expect(hits.map(formatHit)).toEqual([
      'lib/x/copy.ts:1: "MAK-AI Responsible AI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it("the same text inside verbatim('giz-credit', …) passes; through an aliased or namespace import too", () => {
    const text = "'Funded for the MAK-AI Responsible AI Toolkit'";
    expect(lintTs('a/copy.ts', `import { verbatim } from '@/lib/vocabulary/verbatim';\nexport const C = verbatim('giz-credit', ${text});`)).toEqual([]);
    expect(lintTs('a/copy.ts', `import { verbatim as v } from '@/lib/vocabulary/verbatim';\nexport const C = v('legal-text', ${text});`)).toEqual([]);
    expect(lintTs('a/copy.ts', `import * as V from '@/lib/vocabulary/verbatim';\nexport const C = V.verbatim('giz-credit', ${text});`)).toEqual([]);
  });

  it('a verbatim that is not imported from lib/vocabulary/verbatim is linted: a local function, another module', () => {
    expect(lintTs('lib/a/copy.ts', "const verbatim = (_k: string, t: string) => t;\nexport const C = verbatim('giz-credit', 'the RAI Toolkit');")).toHaveLength(1);
    expect(lintTs('lib/a/copy.ts', "import { verbatim } from '@/lib/ui/copy';\nexport const C = verbatim('giz-credit', 'the RAI Toolkit');")).toHaveLength(1);
  });

  it('a verbatim call with any other kind is linted', () => {
    const src = "import { verbatim } from '@/lib/vocabulary/verbatim';\nexport const C = verbatim('other' as never, 'the MAK-AI Responsible AI Toolkit');";
    expect(lintTs('a/copy.ts', src)).toHaveLength(1);
  });

  it('"Google Model Card Toolkit" passes as a proper name', () => {
    expect(PROPER_NAMES).toContain('Google Model Card Toolkit');
    expect(lintText('t', 'Google Model Card Toolkit')).toEqual([]);
    expect(lintText('t', 'the Google Model Card Toolkit')).toEqual([]);
  });

  it('a proper name inside a sentence that also holds a retired phrase still fails on the phrase', () => {
    const hits = lintText('t', 'Use the Google Model Card Toolkit with the Toolkit.');
    expect(hits.map((h) => [h.match, h.rule.id])).toEqual([['the Toolkit', 'product']]);
    expect(lintText('t', 'Google Model Card Toolkit, from the Dashboard').map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('masking: a proper name that itself holds a retired phrase passes, and only its exact span is masked', () => {
    const names = ['Acme Dashboard Kit'];
    expect(lintText('t', 'Acme Dashboard Kit', RULES, [])).toHaveLength(1);
    expect(lintText('t', 'Acme Dashboard Kit', RULES, names)).toEqual([]);
    expect(lintText('t', 'Use Acme Dashboard Kit, not the Dashboard', RULES, names).map((h) => h.rule.id)).toEqual(['dashboard']);
    // The mask is not white space: a whole-string label rule does not see through a masked name.
    expect(lintText('t', 'Explore Acme Dashboard Kit', RULES, names)).toEqual([]);
  });

  it('the same word in our own sentence still fails when it matches a retired phrase', () => {
    expect(lintText('t', 'Open the RAI Toolkit').map((h) => h.rule.id)).toEqual(['product']);
  });

  it('"/orgs/x/dashboard" in a URL passes; "Dashboard" as a word fails (case-sensitive rule)', () => {
    expect(lintText('t', '/orgs/x/dashboard')).toEqual([]);
    expect(lintText('t', 'Back to the dashboard of counts')).toEqual([]);
    expect(lintText('t', 'Back to Dashboard').map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('a case-sensitive rule does not match the other case; a case-insensitive one does', () => {
    expect(lintText('t', 'sign in')).toEqual([]);
    expect(lintText('t', 'Sign In').map((h) => h.rule.id)).toEqual(['sign-in-sign-out']);
    expect(lintText('t', 'EXPECTED PRACTICE').map((h) => h.rule.id)).toEqual(['what-good-looks-like']);
  });

  it('a review item never fails: phraseRules drops it even when its text would match', () => {
    const v = { concepts: [{ id: 'x-id', term: 'x', retired: [
      { text: 'Generate', lint: 'review' as const, why: 'plain word' },
      { text: 'Dash', lint: 'phrase' as const, pattern: '\\bDash\\b', caseSensitive: true },
    ] }], properNames: [] };
    expect(phraseRules(v).map((r) => r.item)).toEqual(['Dash']);
    expect(lintText('t', 'Generate the Dash', phraseRules(v), []).map((h) => h.match)).toEqual(['Dash']);
    expect(lintText('t', 'This action cannot be undone. Generate a report for this session.')).toEqual([]);
  });

  it("a template literal's static parts are scanned and its ${…} holes are not", () => {
    expect(lintTs('a/copy.ts', 'export const f = (Dashboard: string) => `Open ${Dashboard} now`;')).toEqual([]);
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `Open the Dashboard (${n})`;').map((h) => h.rule.id)).toEqual(['dashboard']);
    // A hole does not join its neighbours into a whole-string label.
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `${n} Post`;')).toEqual([]);
    expect(lintTs('a/copy.ts', "export const C = 'Post';").map((h) => h.rule.id)).toEqual(['stage-3']);
  });

  it('a property name is not copy; its value is', () => {
    expect(lintTs('a/copy.ts', "export const S = { 'pre-processing': 'Pre-processing' };")).toEqual([]);
    expect(lintTs('a/copy.ts', "export const S = { 'Dashboard': 'Home' };")).toEqual([]);
    expect(lintTs('a/copy.ts', "export const S = { home: 'Dashboard' };").map((h) => h.rule.id)).toEqual(['dashboard']);
    expect(lintTs('a/copy.ts', "export interface S { 'Dashboard': string }\nexport class C { 'Dashboard' = 1; }\nexport enum E { 'Dashboard' = 1 }")).toEqual([]);
  });

  it('a case label is not copy', () => {
    expect(lintTs('a/copy.ts', "export const f = (x: string) => { switch (x) { case 'Dashboard': return 1; default: return 0; } };")).toEqual([]);
  });

  it('a literal type is not copy', () => {
    expect(lintTs('a/copy.ts', "export type T = 'Dashboard' | 'Post';\nexport const x = y as 'Dashboard';")).toEqual([]);
  });

  it('an element-access key is not copy', () => {
    expect(lintTs('a/copy.ts', "export const v = m['Dashboard'];")).toEqual([]);
  });

  it('an operand of ===, !==, == or != is not copy; other operators are', () => {
    expect(lintTs('a/copy.ts', "export const a = x === 'Dashboard' || x !== 'Post' || x == 'In' || x != 'Pre';")).toEqual([]);
    expect(lintTs('a/copy.ts', "export const a = x || 'Dashboard';").map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('a TypeScript file that does not parse fails the scan, naming the file', () => {
    expect(() => lintTs('lib/a/copy.ts', "export const C = <p>the RAI Toolkit</p>;")).toThrow(/lib\/a\/copy\.ts/);
  });

  it("a multi-line template reports the hit on the hit's own line", () => {
    const src = "export const f = (n: number) => `First line ${n}\nsecond line\nBack to the Dashboard`;";
    expect(lintTs('a/copy.ts', src).map(formatHit)).toEqual(['a/copy.ts:3: "Dashboard" → use "Home" (concept dashboard)']);
  });

  it('adjacent literals joined by + are read as one string, a non-literal operand as a hole', () => {
    expect(lintTs('a/copy.ts', "export const C = 'Open the ' +\n  'RAI ' + 'Toolkit';").map(formatHit))
      .toEqual(['a/copy.ts:2: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)']);
    expect(lintTs('a/copy.ts', "export const C = (n: string) => n + ' Post';")).toEqual([]);
    expect(lintTs('a/copy.ts', "export const C = (n: string) => 'Back to ' + n + ' Dashboard';").map((h) => h.rule.id)).toEqual(['dashboard']);
  });

  it('import and export paths are not copy', () => {
    expect(lintTs('a/copy.ts', "import { x } from '@/lib/Dashboard';\nexport { y } from './Dashboard';")).toEqual([]);
  });

  it('HTML: text nodes are scanned; script, style and a data-verbatim element of an allowed kind are not', () => {
    const html = [
      '<html><head><style>.Dashboard{}</style><script>const s = "Dashboard";</script></head><body>',
      '<p data-verbatim="giz-credit">the MAK-AI Responsible AI Toolkit <b>Dashboard</b></p>',
      '<p data-verbatim="other">Dashboard one</p>',
      '<p>Use the <em>RAI Toolkit</em> here &amp; there</p>',
      '</body></html>',
    ].join('\n');
    expect(lintHtml('t.html', html).map(formatHit)).toEqual([
      't.html:3: "Dashboard" → use "Home" (concept dashboard)',
      't.html:4: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('plain text is read by paragraph: a phrase across a line wrap is found and reported on the line it starts', () => {
    const notice = 'Subject: notice\n\nA login was made at the\nRAI\n   Toolkit server.\n\nEvent: {EVENT}';
    expect(textBlocks(notice, false).flatMap((b) => lintText((i) => `n.txt:${b.lineAt(i)}`, b.text)).map(formatHit).sort()).toEqual([
      'n.txt:3: "login" → use "sign in, sign out" (concept sign-in-sign-out)',
      'n.txt:4: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('markdown is read by block: wrapped lines join; a heading is one line; a list item starts a block', () => {
    expect(textBlocks('# Organization\nroles\n- Dashboard\n  continued\n- item', true).map((b) => b.text)).toEqual(['# Organization', 'roles', '- Dashboard continued', '- item']);
    expect(textBlocks('# Title\nPart of the RAI\nToolkit.', true).map((b) => b.text)).toEqual(['# Title', 'Part of the RAI Toolkit.']);
  });

  it('notebooks: a phrase wrapped across lines of a markdown cell is found, on its first line', () => {
    const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['Intro.\n', '\n', 'Part of the RAI\n', 'Toolkit.\n'] }] });
    expect(notebookTexts('n.ipynb', nb).flatMap((t) => lintText(t.where, t.text)).map(formatHit)).toEqual([
      'n.ipynb:cell 1 line 3: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('notebooks: markdown cells are scanned, code cells are not', () => {
    const nb = JSON.stringify({ cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Part of the RAI Toolkit.\n'] },
      { cell_type: 'code', source: ['print("RAI Toolkit")\n'] },
    ] });
    expect(notebookTexts('n.ipynb', nb).flatMap((t) => lintText(t.where, t.text)).map(formatHit)).toEqual([
      'n.ipynb:cell 1 line 2: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('a version tag of our own copy fails, including one before a template hole; a path or a dotted version passes', () => {
    expect(lintText('t', 'Saved as v3').map((h) => h.rule.id).sort()).toEqual(['legal-text-version', 'version-of-a-decision']);
    expect(lintText('t', 'Q-PP-03 v3')).toHaveLength(2);
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `Saved as v${n}`;')).toHaveLength(2);
    expect(lintText('t', '/api/v1/orgs and v1.2.3 and x-v2')).toEqual([]);
    // Recorded limit: a third-party version after its name still hits (notebooks only today, report-only).
    expect(lintText('t', 'World Bank (api.worldbank.org v2, retrieved 30 Oct 2026)')).toHaveLength(2);
  });

  it('"organization" in our own text fails; a capitalised name mid-sentence passes', () => {
    expect(lintText('t', 'Adapt titles to your organization.').map((h) => h.match)).toEqual(['organization']);
    expect(lintText('t', '1. Organizational roles').map((h) => h.match)).toEqual(['Organizational']);
    expect(lintText('t', 'Guidance from the World Health Organization')).toEqual([]);
  });

  it('the worklist ratchet refuses a new hit, and allows fewer', () => {
    const allowed: Worklist = { 'lib/a/copy.ts': { 'dashboard :: Dashboard': 1 } };
    const planted = lintTs('lib/a/copy.ts', "export const A = 'Back to Dashboard';\nexport const B = 'Open the RAI Toolkit';");
    expect(ratchetViolations(worklistOf(planted), allowed)).toEqual([
      'lib/a/copy.ts: product :: RAI Toolkit: 1 hit(s), the worklist allows 0',
    ]);
    const twice = lintTs('lib/a/copy.ts', "export const A = 'Dashboard';\nexport const B = 'Back to Dashboard';");
    expect(ratchetViolations(worklistOf(twice), allowed)).toEqual(['lib/a/copy.ts: dashboard :: Dashboard: 2 hit(s), the worklist allows 1']);
    expect(ratchetViolations(worklistOf([]), allowed)).toEqual([]);
  });

  it('content: a phrase planted in a signed field and in an unsigned field fails, each with its sign-off status', () => {
    const bundle = {
      'questionBank.json': { stages: { s: { modules: [{ id: 'm', title: 'T', questions: [{ id: 'q', text: 'Q?', whyAsked: 'Open the RAI Toolkit.' }] }] } } },
      'assessmentAreas.json': { controls: [{ id: 'C-01', description: 'See the Dashboard.' }] },
    };
    const units = contentStrings(bundle, 'fixture', CONTENT_EXCLUSIONS, SIGNED_KEYS);
    expect(units.map((u) => u.where)).toEqual([
      'fixture/questionBank.json:stages.s.modules[0].title', 'fixture/questionBank.json:stages.s.modules[0].questions[0].text',
      'fixture/questionBank.json:stages.s.modules[0].questions[0].whyAsked', 'fixture/assessmentAreas.json:controls[0].description',
    ]);
    expect(scopeContent(units).map((h) => `${h.signed ? 'signed' : 'unsigned'} ${formatHit(h)}`)).toEqual([
      'signed fixture/questionBank.json:stages.s.modules[0].questions[0].whyAsked: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
      'unsigned fixture/assessmentAreas.json:controls[0].description: "Dashboard" → use "Home" (concept dashboard)',
    ]);
  });

  it('content: a value that is neither text nor a list or object of text is refused, naming its path', () => {
    expect(() => contentStrings({ 'documentHelp.json': { data_card: 3 } }, 'fixture', CONTENT_EXCLUSIONS, SIGNED_KEYS)).toThrow(/documentHelp\.json:data_card/);
  });

  it('field maps: a field map without a fields list, or a label or section that is not text, throws', () => {
    expect(() => fieldMapTexts('f.json', '{}')).toThrow(/f\.json/);
    expect(() => fieldMapTexts('f.json', JSON.stringify({ fields: [{ label: 'A', section: 1 }] }))).toThrow(/fields\[0\]\.section/);
    expect(() => fieldMapTexts('f.json', JSON.stringify({ fields: [{ section: 'S' }] }))).toThrow(/fields\[0\]\.label/);
    expect(fieldMapTexts('f.json', JSON.stringify({ fields: [{ label: 'A', section: 'S' }] })).map((t) => t.where)).toEqual(['f.json:fields[0].label', 'f.json:fields[0].section']);
  });
});

/**
 * Scope (2) is every string value in the running bundle's content files, except the keys below: values that are
 * identifiers, codes, links or enumerated kinds, never text a reader is shown as a sentence. Each excluded key must
 * exist in the bundle, so an exclusion that has gone stale fails. A new key in a later content version is scanned.
 */
const CONTENT_EXCLUSIONS: ContentExclusions = {
  'questionBank.json': {
    version: 'the content version number', id: 'module and question ids', type: 'the question type code (likert-5, gate, checklist)',
    gaps: 'gap ids', questionId: 'the id a condition names', value: 'the answer value a condition tests (yes)',
    area: 'risk-area ids in optionGapMap', role: 'the mapping role code (primary, supporting, supplementary)',
  },
  'reasonCodes.json': { code: 'the reason code id (na_…, ny_…)', status: 'the status code it belongs to (not_applicable, not_yet)' },
  'assessmentAreas.json': {
    version: 'the content version number', lastUpdated: 'a date stamp', id: 'stage, area and control ids',
    color: 'a colour value', icon: 'an icon name', stage: 'the stage key (pre-processing, …)', controls: 'control ids an area links',
    doi: 'a DOI', url: 'a link', type: 'the control or resource kind code (procedural, framework, tool, …)',
  },
  'projectConfig.json': { version: 'a version number', principlesSourceUrl: 'a link' },
};

/**
 * The keys a sign-off covers (lib/content/signoffs.ts `signOffPayload`): question text, expectedPractice, whyAsked,
 * reasonPrompt, evidenceExamples, helpText, example; every documentHelp value; reason codes' label, useWhen and
 * reasonMustSay (code and status are signed too, and excluded above as codes). Only the message uses it.
 */
const SIGNED_KEYS: SignedKeys = {
  'questionBank.json': ['text', 'expectedPractice', 'whyAsked', 'reasonPrompt', 'evidenceExamples', 'helpText', 'example'],
  'documentHelp.json': '*',
  'reasonCodes.json': ['code', 'status', 'label', 'useWhen', 'reasonMustSay'],
};
/** Signed keys that no 5.1.0 question carries: allowed to be absent, scanned and signed when they appear. */
const SIGNED_KEYS_MAY_BE_ABSENT = ['helpText', 'example'];
/**
 * The strings scope (2) reads, per running version. Tolerance 0: content changes only by a new, signed content
 * version, and that change is the moment to record its count here; a field that vanishes or a key newly excluded
 * then shows as a different number, never as a quiet pass.
 */
const CONTENT_STRINGS: Record<string, number> = { 'data/content/5.1.0': 977 };

/** Today's counts (13 Nov 2026), as floors: a scope that reads fewer strings has lost a file or a field. */
const COPY_STRINGS_FLOOR = 206;
const FIELD_MAP_STRINGS_FLOOR = 156;
const EMAIL_STRINGS_FLOOR = 45;

describe('the vocabulary lint, on the repository', () => {
  it('scope (2): every string of the running content bundle, signed and unsigned, holds no retired phrase', () => {
    const bundle = readBundle(RUNNING);
    const units = contentStrings(bundle, RUNNING, CONTENT_EXCLUSIONS, SIGNED_KEYS);
    console.log(`vocabulary lint: ${RUNNING}: ${units.length} strings (${units.filter((u) => u.signed).length} signed)`);
    const hits = scopeContent(units);
    expect(hits.map((h) => `${h.signed ? 'signed' : 'unsigned'} ${formatHit(h)} in: ${h.text}`)).toEqual([]);
    expect(units.length, `strings read in ${RUNNING}`).toBe(CONTENT_STRINGS[RUNNING]);
  });

  it('scope (2): every excluded key exists, and every signed key occurs in the bundle and in lib/content/signoffs.ts', () => {
    const bundle = readBundle(RUNNING);
    expect(Object.keys(bundle).sort()).toEqual([...CONTENT_FILES].sort());
    const keysIn = (v: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
      return out;
    };
    const missing: string[] = [];
    for (const [file, keys] of Object.entries(CONTENT_EXCLUSIONS)) {
      const present = keysIn(bundle[file]);
      for (const k of Object.keys(keys)) if (!present.has(k)) missing.push(`excluded ${file}:${k}`);
    }
    const signoffs = readFileSync(join(__dirname, '../../lib/content/signoffs.ts'), 'utf8');
    for (const [file, keys] of Object.entries(SIGNED_KEYS)) {
      if (keys === '*') continue;
      const present = keysIn(bundle[file]);
      for (const k of keys) {
        if (!present.has(k) && !SIGNED_KEYS_MAY_BE_ABSENT.includes(k)) missing.push(`signed ${file}:${k}`);
        if (!new RegExp(`\\b${k}\\b`).test(signoffs)) missing.push(`signed ${k} not in lib/content/signoffs.ts`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('scopes (1), (3) and (4) were scanned: files and strings at or above today\'s floors', () => {
    const { copy, fieldMaps, email } = scanWorklistScopes();
    console.log(`vocabulary lint: copy modules ${copy.files.length} files / ${copy.strings} strings, field maps ${fieldMaps.files.length} / ${fieldMaps.strings}, email ${email.files.length} / ${email.strings}`);
    expect(copy.files).toEqual(expect.arrayContaining(['lib/decision/copy.ts', 'lib/documents/copy.ts', 'lib/evidence/copy.ts', 'lib/followup/copy.ts']));
    expect(copy.strings).toBeGreaterThanOrEqual(COPY_STRINGS_FLOOR);
    expect(fieldMaps.files).toEqual(['data/fieldmaps/data_card.json', 'data/fieldmaps/mitigation_plan.json', 'data/fieldmaps/model_card.json']);
    expect(fieldMaps.strings).toBeGreaterThanOrEqual(FIELD_MAP_STRINGS_FLOOR);
    expect(email.files).toEqual(expect.arrayContaining(['lib/email/templates.ts', 'ops/host/break-glass-notice.txt']));
    expect(email.files.filter((f) => f.startsWith('lib/email/templates/')).length).toBeGreaterThanOrEqual(6);
    expect(email.strings).toBeGreaterThanOrEqual(EMAIL_STRINGS_FLOOR);
  });

  it('the worklist only shrinks: no file has more hits of a retired item than vocabulary-worklist.json allows', () => {
    const current = worklistOf(worklistHits());
    writeHits('vocabulary-hits-baseline.txt', worklistHits());
    if (process.env.VOCABULARY_WORKLIST_PRINT === '1') console.log(JSON.stringify(current, null, 2));
    const allowed = JSON.parse(readFileSync(WORKLIST_FILE, 'utf8')) as Worklist;
    expect(ratchetViolations(current, allowed)).toEqual([]);
  });

  // Scopes (1) copy modules, (3) field maps and (4) email all hold hits today: the worklist of the copy tasks.
  // Register row (toolkit-process/docs/DEFERRED_REGISTER.md), trigger "Task 20 merged"; Task 20 removes `.fails`.
  it.fails('vocabulary lint (worklist until Task 20)', () => {
    expect(worklistHits().map(formatHit)).toEqual([]);
  });

  it('templates (scope 5, stage 3): report-only, prints the count, never fails', () => {
    const r = scopeTemplates();
    writeHits('vocabulary-template-hits.txt', r.hits);
    console.log(`vocabulary lint: ${r.hits.length} hit(s) in public/templates, ${r.files.length} files / ${r.strings} strings (report-only until stage 3)`);
  });

  it('notebooks (scope 6, stage 3): report-only, prints the count, never fails', () => {
    const r = scopeNotebooks();
    writeHits('vocabulary-notebook-hits.txt', r.hits);
    console.log(`vocabulary lint: ${r.hits.length} hit(s) in notebooks, ${r.files.length} files / ${r.strings} strings (report-only until stage 3)`);
  });
});
