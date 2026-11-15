import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { casesOf, requireBaseTag, unexplainedRemovals, type LedgerEntry } from '../helpers/protectedDiff';

/**
 * A test title that existed at the base tag and is gone at HEAD must be accounted for in `test-replacements.json`:
 * an entry names the removed case (`deleted`, or `changed` for a reworded one), a `replacedBy` title that exists at
 * HEAD, and says which property it still proves (`property`) and where (`proof`). Protected files are held to the
 * stricter rule in protected-tests.test.ts.
 */

const BASE = (JSON.parse(readFileSync('__tests__/lint/protected-tests.json', 'utf8')) as { base: string }).base;
const ledger = JSON.parse(readFileSync('__tests__/lint/test-replacements.json', 'utf8')) as LedgerEntry[];
const TEST_FILE = /^(__tests__|e2e)\/.*\.(test|spec)\.[cm]?[jt]sx?$/;

const titlesAtHead = (file: string): string[] => (existsSync(file) ? casesOf(readFileSync(file, 'utf8'), file).map((c) => c.title) : []);
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });

it('every test title at the base tag that is absent at HEAD has a replacement entry naming a title that exists at HEAD', () => {
  requireBaseTag(BASE, git);
  const baseTitles: Record<string, string[]> = {};
  for (const file of git('ls-tree', '-r', '--name-only', BASE).split('\n').filter((f) => TEST_FILE.test(f))) {
    baseTitles[file] = casesOf(git('show', `${BASE}:${file}`), file).map((c) => c.title);
  }
  expect(Object.keys(baseTitles).length).toBeGreaterThan(0);
  expect(unexplainedRemovals({ baseTitles, titlesAtHead, ledger })).toEqual([]);
}, 60_000); // reads every test file of the base tag from git

it('(harness) a removed title without an entry fails; an entry needs an existing replacedBy, a property and a proof', () => {
  const baseTitles = { 'a.test.ts': ['kept', 'gone'] };
  const headTitles: Record<string, string[]> = { 'a.test.ts': ['kept', 'new'] };
  const at = (f: string): string[] => headTitles[f] ?? [];
  const entry: LedgerEntry = { kind: 'removed', deleted: 'a.test.ts::gone', replacedBy: 'a.test.ts::new', property: 'still saves', proof: 'a.test.ts::new', task: 'Task 9' };
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: at, ledger: [] })).toHaveLength(1);
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: at, ledger: [entry] })).toEqual([]);
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: at, ledger: [{ ...entry, replacedBy: 'a.test.ts::missing' }] })).toHaveLength(1);
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: at, ledger: [{ ...entry, property: ' ' }] })).toHaveLength(1);
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: at, ledger: [{ ...entry, proof: '' }] })).toHaveLength(1);
  // a title added at HEAD needs nothing
  expect(unexplainedRemovals({ baseTitles: { 'a.test.ts': ['kept'] }, titlesAtHead: at, ledger: [] })).toEqual([]);
});

it('(harness) removing one of two cases with the same title is a removal', () => {
  const baseTitles = { 'a.test.ts': ['twice', 'twice', 'kept'] };
  const atHead = (): string[] => ['twice', 'kept'];
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: atHead, ledger: [] })).toHaveLength(1);
  const entry: LedgerEntry = { kind: 'removed', deleted: 'a.test.ts::twice', replacedBy: 'a.test.ts::kept', property: 'p', proof: 'q', task: 't' };
  expect(unexplainedRemovals({ baseTitles, titlesAtHead: atHead, ledger: [entry] })).toEqual([]);
  expect(unexplainedRemovals({ baseTitles: { 'a.test.ts': ['twice', 'twice'] }, titlesAtHead: () => ['twice', 'twice'], ledger: [] })).toEqual([]);
});
