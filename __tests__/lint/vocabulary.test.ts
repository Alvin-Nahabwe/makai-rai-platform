import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentExtraFields, contentFields, formatHit, lintHtml, lintText, lintTs, notebookTexts, PROPER_NAMES, ratchetViolations,
  RULES, RUNNING, scopeContent, scopeCopyModules, scopeEmail, scopeFieldMaps, scopeNotebooks, type ScopeResult,
  scopeTemplates, VOCABULARY, type Worklist, worklistOf, writeHits,
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
  const ruleOf = (id: string) => RULES.filter((r) => r.id === id);

  it('every phrase pattern in data/vocabulary.json compiles, and every retired item is phrase or review', () => {
    const items = VOCABULARY.concepts.flatMap((c) => c.retired);
    expect(items.length).toBeGreaterThan(0);
    for (const r of items) expect(['phrase', 'review']).toContain(r.lint);
    expect(RULES.length).toBe(items.filter((r) => r.lint === 'phrase').length);
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

  it('a review item never fails: each review item\'s own text raises no hit for that item', () => {
    const review = VOCABULARY.concepts.flatMap((c) => c.retired.filter((r) => r.lint === 'review').map((r) => ({ id: c.id, text: r.text })));
    expect(review.length).toBeGreaterThan(0);
    for (const r of review) {
      expect(lintText('t', r.text).filter((h) => h.rule.id === r.id && h.rule.item === r.text), r.text).toEqual([]);
    }
    expect(lintText('t', 'This action cannot be undone. Generate a report for this session.')).toEqual([]);
  });

  it("a template literal's static parts are scanned and its ${…} holes are not", () => {
    expect(lintTs('a/copy.ts', 'export const f = (Dashboard: string) => `Open ${Dashboard} now`;')).toEqual([]);
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `Open the Dashboard (${n})`;').map((h) => h.rule.id)).toEqual(['dashboard']);
    // A hole does not join its neighbours into a whole-string label.
    expect(lintTs('a/copy.ts', 'export const f = (n: number) => `${n} Post`;')).toEqual([]);
    expect(lintTs('a/copy.ts', "export const C = 'Post';").map((h) => h.rule.id)).toEqual(['stage-3']);
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

  it('notebooks: markdown cells are scanned, code cells are not', () => {
    const nb = JSON.stringify({ cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Part of the RAI Toolkit.\n'] },
      { cell_type: 'code', source: ['print("RAI Toolkit")\n'] },
    ] });
    expect(notebookTexts('n.ipynb', nb).flatMap((t) => lintText(t.where, t.text)).map(formatHit)).toEqual([
      'n.ipynb:cell 1 line 2: "RAI Toolkit" → use "MAK-AI RAI Platform" (concept product)',
    ]);
  });

  it('a third-party version number after its name passes; a bare version tag fails', () => {
    expect(lintText('t', 'World Bank (api.worldbank.org v2, retrieved 30 Oct 2026)')).toEqual([]);
    expect(lintText('t', 'Python v3')).toEqual([]);
    expect(lintText('t', 'Q-PP-03 · v3').map((h) => h.rule.id).sort()).toEqual(['legal-text-version', 'version-of-a-decision']);
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

  it('content fields carry their sign-off status: question texts and reason codes signed, area names not', () => {
    const fields = contentFields(RUNNING);
    expect(fields.find((f) => f.where.endsWith('.questions[0].text'))?.signed).toBe(true);
    expect(fields.find((f) => f.where.includes('reasonCodes.json:codes[0].label'))?.signed).toBe(true);
    expect(fields.find((f) => f.where.endsWith('areas[0].name'))?.signed).toBe(false);
    expect(fields.find((f) => f.where.endsWith('meta.framework'))?.signed).toBe(false);
    expect(ruleOf('product').length).toBe(3);
  });
});

/** Today's counts (13 Nov 2026), as floors: a scope that reads fewer strings has lost a file or a field. */
const COPY_STRINGS_FLOOR = 211;
const FIELD_MAP_STRINGS_FLOOR = 156;
const EMAIL_STRINGS_FLOOR = 55;

describe('the vocabulary lint, on the repository', () => {
  it('scope (2): the running content bundle, signed and unsigned fields, holds no retired phrase', () => {
    const fields = contentFields(RUNNING);
    expect(fields.length).toBeGreaterThan(500);
    const hits = scopeContent(fields);
    expect(hits.map((h) => `${h.signed ? 'signed' : 'unsigned'} ${formatHit(h)} in: ${h.text}`)).toEqual([]);
  });

  it('rendered content fields outside the scope list: report-only, prints the count', () => {
    const hits = scopeContent(contentExtraFields(RUNNING));
    console.log([`vocabulary lint: ${hits.length} hit(s) in rendered content fields the scope list does not name`, ...hits.map(formatHit)].join('\n'));
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
    const hits = scopeTemplates();
    writeHits('vocabulary-template-hits.txt', hits);
    console.log(`vocabulary lint: ${hits.length} hit(s) in public/templates (report-only until stage 3)`);
  });

  it('notebooks (scope 6, stage 3): report-only, prints the count, never fails', () => {
    const hits = scopeNotebooks();
    writeHits('vocabulary-notebook-hits.txt', hits);
    console.log(`vocabulary lint: ${hits.length} hit(s) in notebooks (report-only until stage 3)`);
  });
});
