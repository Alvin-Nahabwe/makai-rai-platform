import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  casesOf,
  checkProtectedFile,
  compareSources,
  copyImportsOf,
  resolveBaseSource,
  sameUnits,
  type GitAdapter,
  type LedgerEntry,
} from '../helpers/protectedDiff';

/**
 * Spec 12: while the interface is reworded, a protected test (one that pins saving, drafts, conflicts, sealing,
 * export, authorisation or tenant isolation) may change only where a message literal became a copy constant.
 * `protected-tests.json` lists the files (scripts/redesign/protected-tests.mjs writes it); `test-replacements.json`
 * excuses a case that had to change for a reason spec 12 allows. Every comparison is against the tag in the
 * ledger's `base`, never against v0.6.0. Plan 1C imports `compareSources` for its frozen files.
 */

type Ledger = { base: string; files: string[]; humanRead: string[]; mainMerges: string[] };

const protectedLedger = JSON.parse(readFileSync('__tests__/lint/protected-tests.json', 'utf8')) as Ledger;
const replacements = JSON.parse(readFileSync('__tests__/lint/test-replacements.json', 'utf8')) as LedgerEntry[];

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
const realGit: GitAdapter = {
  show: (ref, file) => git('show', `${ref}:${file}`),
  changed: (a, b, file) => git('diff', '--name-only', a, b, '--', file).trim() !== '',
};
const headTitlesOf = (file: string): string[] => casesOf(readFileSync(file, 'utf8'), file).map((c) => c.title);

it('spec 12: a protected test changes only where a message literal became a copy constant, or the ledger excuses it', () => {
  expect(protectedLedger.base).toBe('stage-1-base');
  expect(protectedLedger.files.length).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const file of protectedLedger.files) {
    problems.push(
      ...checkProtectedFile({
        file,
        baseSource: resolveBaseSource(file, protectedLedger.base, protectedLedger.mainMerges, realGit),
        headSource: readFileSync(file, 'utf8'),
        isHumanRead: protectedLedger.humanRead.includes(file),
        ledger: replacements,
        titlesAtHead: headTitlesOf,
      }),
    );
  }
  expect(problems).toEqual([]);
});

// ---- harness: the comparison itself ------------------------------------------------------------------------------

const FILE = '__tests__/unit/save.test.ts';
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  kind: 'rule',
  replacedBy: `${FILE}::new case`,
  property: 'p',
  proof: 'q',
  task: 't',
  ...over,
});
const base = (body: string): string => `import { it, expect } from 'vitest';\n\nit('saves', () => {\n${body}\n});\n`;
const check = (baseSource: string, headSource: string, over: { isHumanRead?: boolean; ledger?: LedgerEntry[]; titles?: string[] } = {}): string[] =>
  checkProtectedFile({
    file: FILE,
    baseSource,
    headSource,
    isHumanRead: over.isHumanRead ?? false,
    ledger: over.ledger ?? [],
    titlesAtHead: () => over.titles ?? [],
  });
const COPY_IMPORT = "import { DECISION_COPY, EVIDENCE_COPY } from '@/lib/decision/copy';\n";

it('(harness) a literal changed to a different literal fails; a literal replaced by DECISION_COPY.saved passes', () => {
  const before = base("  expect(msg).toBe('Saved.');");
  expect(check(before, base("  expect(msg).toBe('Saved and kept.');")).length).toBeGreaterThan(0);
  expect(check(before, COPY_IMPORT + base('  expect(msg).toBe(DECISION_COPY.saved);'))).toEqual([]);
  expect(sameUnits("expect(m).toBe('Saved.');", "expect(m).toBe('Saved and kept.');", new Set())).toBe(false);
  expect(sameUnits("expect(m).toBe('Saved.');", 'expect(m).toBe(DECISION_COPY.saved);', new Set())).toBe(true);
});

it('(harness) /^Saved as version 1 at / replaced by new RegExp(`^${DECISION_COPY.savedPrefix}`) normalises equal', () => {
  const before = '  expect(msg).toMatch(/^Saved as version 1 at /);';
  const after = '  expect(msg).toMatch(new RegExp(`^${DECISION_COPY.savedPrefix}`));';
  expect(sameUnits(before.trim(), after.trim(), new Set())).toBe(true);
  expect(check(base(before), COPY_IMPORT + base(after))).toEqual([]);
  // flags: a regex with flags against RegExp(X, 'i')
  expect(sameUnits('x.toMatch(/^Saved/i);', "x.toMatch(RegExp(DECISION_COPY.saved, 'i'));", new Set())).toBe(true);
  // a regex replaced by a different regex still fails
  expect(sameUnits('x.toMatch(/^Saved/);', 'x.toMatch(/^Kept/);', new Set())).toBe(false);
});

it('(harness) "Save without it" replaced by EVIDENCE_COPY.saveWithout(1) normalises equal', () => {
  const before = "  await screen.getByText('Save without it');";
  const after = '  await screen.getByText(EVIDENCE_COPY.saveWithout(1));';
  expect(check(base(before), COPY_IMPORT + base(after))).toEqual([]);
  // a call whose argument is not a literal or a copy constant is not one unit
  expect(sameUnits("getByText('Save without it');", 'getByText(EVIDENCE_COPY.saveWithout(count));', new Set())).toBe(false);
});

it('(harness) an added import from ../lib/documents/copy is ignored', () => {
  const body = "  expect(msg).toBe('Saved.');";
  const head = "import { DOCUMENT_COPY } from '../lib/documents/copy';\n" + base(body);
  expect(compareSources(base(body), head)).toEqual([]);
  // an added import from anywhere else is an added line and breaks rule (d)
  const other = "import { helper } from '../lib/documents/other';\n" + base(body);
  expect(compareSources(base(body), other).length).toBeGreaterThan(0);
  // a multi-line copy import is dropped whole
  const multi = "import {\n  A_COPY,\n  B_COPY,\n} from '@/lib/question/copy';\n" + base(body);
  expect(compareSources(base(body), multi)).toEqual([]);
});

it('(harness) a structure or rule entry whose replacedBy title does not exist at HEAD fails', () => {
  const baseSource = base("  expect(a).toBe(1);") + "\nit('old case', () => {\n  expect(a).toBe(1);\n});\n";
  const headSource = base("  expect(a).toBe(1);");
  const ledger = [entry({ kind: 'structure', deleted: `${FILE}::old case` })];
  expect(check(baseSource, headSource, { ledger, titles: ['saves'] }).length).toBeGreaterThan(0);
  expect(check(baseSource, headSource, { ledger, titles: ['saves', 'new case'] })).toEqual([]);
});

it('(harness) a changed protected case with only a removed-kind entry fails', () => {
  const before = base("  expect(msg).toBe('Saved.');");
  const after = base("  expect(msg).toBe('Saved and kept.');");
  const removedOnly = [entry({ kind: 'removed', changed: `${FILE}::saves` })];
  expect(check(before, after, { ledger: removedOnly, titles: ['new case'] }).length).toBeGreaterThan(0);
  const rule = [entry({ kind: 'rule', changed: `${FILE}::saves` })];
  expect(check(before, after, { ledger: rule, titles: ['new case'] })).toEqual([]);
});

it('(harness) a humanRead file with no wording entry for a changed case fails', () => {
  const before = base("  expect(msg).toBe('Saved.');");
  const after = base("  expect(msg).toBe(['Saved', 'and kept.'].join(' '));");
  expect(check(before, after, { isHumanRead: true }).length).toBeGreaterThan(0);
  const wording = [entry({ kind: 'wording', changed: `${FILE}::saves` })];
  expect(check(before, after, { isHumanRead: true, ledger: wording, titles: ['new case'] })).toEqual([]);
  // an unchanged case in a humanRead file needs no entry
  expect(check(before, before, { isHumanRead: true })).toEqual([]);
});

it('(harness) a case added to a protected file passes with no ledger entry; a baseline case removed without one fails', () => {
  const body = "  expect(a).toBe(1);";
  const added = base(body) + "\nit('a new case', () => {\n  expect(b).toBe('anything');\n});\n";
  expect(check(base(body), added)).toEqual([]);
  expect(check(added, base(body)).length).toBeGreaterThan(0);
});

it('(harness) 10_000 replaced by OTHER_CONST fails; 2 replaced by DECISION_COPY.count fails', () => {
  expect(sameUnits('const SLOW_MS = 10_000;', 'const SLOW_MS = OTHER_CONST;', new Set())).toBe(false);
  expect(sameUnits('expect(x).toHaveLength(2);', 'expect(x).toHaveLength(DECISION_COPY.count);', new Set())).toBe(false);
  expect(sameUnits('const SLOW_MS = 10_000;', 'const SLOW_MS = 10_000;', new Set())).toBe(true);
});

it('(harness) a literal replaced by a name imported from a copy module passes; by an upper-case name imported elsewhere fails', () => {
  const before = "expect(m).toBe('Say what is in place.');";
  const after = 'expect(m).toBe(REASON_HELP);';
  const fromCopy = copyImportsOf("import { REASON_HELP } from '@/lib/decision/copy';\n");
  const fromElsewhere = copyImportsOf("import { REASON_HELP } from '@/lib/decision/other';\n");
  expect(fromCopy.has('REASON_HELP')).toBe(true);
  expect(fromElsewhere.has('REASON_HELP')).toBe(false);
  expect(sameUnits(before, after, fromCopy)).toBe(true);
  expect(sameUnits(before, after, fromElsewhere)).toBe(false);
  expect(copyImportsOf("import { A as B } from '../../lib/x/copy';\nimport * as C from '@/lib/y/copy';\nimport D from '@/lib/z/copy';\n")).toEqual(new Set(['B', 'C', 'D']));
});

it('(harness) a protected file changed only by a listed main merge passes', () => {
  const fake = (changedByMerge: boolean): GitAdapter => ({
    show: (ref) => (ref === 'abc123^2' ? 'MAIN SIDE' : 'BASE SIDE'),
    changed: (a, b) => changedByMerge && a === 'stage-1-base' && b === 'abc123^2',
  });
  expect(resolveBaseSource(FILE, 'stage-1-base', ['abc123'], fake(true))).toBe('MAIN SIDE');
  expect(resolveBaseSource(FILE, 'stage-1-base', ['abc123'], fake(false))).toBe('BASE SIDE');
  expect(resolveBaseSource(FILE, 'stage-1-base', [], fake(true))).toBe('BASE SIDE');
});
