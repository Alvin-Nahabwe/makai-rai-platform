import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Plan 1B Task 5, "Permitted change": the D16 exception to the frozen draft storage (spec 2; review H4). The only change
 * to lib/client/drafts.ts since `stage-1-base` is the read-only `hasOtherAccounts`: one member of `interface DraftStore`
 * and one property of the object `openDraftStore` returns, additions only. And S-01's four draft and sign-in functions
 * are as they were at `stage-1-base` (never v0.6.0: plan 1A Task 0), so `.purgeOtherAccounts(` is still called where
 * e2e/decision-drafts.spec.ts and e2e/decision-idle-signout.spec.ts look for it.
 */
const BASE = 'stage-1-base';
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 });

/** The text of `function <name>` (with its leading doc comment's last line excluded): from its line to its closing brace at column 0. */
function functionText(src: string, name: string): string {
  const start = src.search(new RegExp(`^(export )?(async )?function ${name}\\b`, 'm'));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

it('D16: lib/client/drafts.ts gains only hasOtherAccounts, in DraftStore and in the returned object, and loses no line', () => {
  git('rev-parse', '--verify', `${BASE}^{commit}`);
  const diff = git('diff', '--unified=0', BASE, '--', 'lib/client/drafts.ts');
  const lines = diff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
  expect(lines.filter((l) => l.startsWith('-')), 'no line removed or edited').toEqual([]);
  const added = lines.map((l) => l.slice(1));
  expect(added.length).toBeGreaterThan(0);

  const head = readFileSync('lib/client/drafts.ts', 'utf8');
  const iface = head.slice(head.indexOf('export interface DraftStore {'), head.indexOf('\n}\n', head.indexOf('export interface DraftStore {')));
  const returned = head.slice(head.lastIndexOf('  return {\n'), head.lastIndexOf('\n  };\n'));
  // The interface member: its doc comment and its signature, right after `count`.
  const member = /\n( {2}\/\*\*[^\n]*\*\/\n {2}hasOtherAccounts\(userId: string, now: Date\): boolean;)/.exec(iface)?.[1] ?? '';
  expect(member, 'the DraftStore member').not.toBe('');
  expect(iface.indexOf(member)).toBeGreaterThan(iface.indexOf('  count('));
  expect(iface.indexOf(member)).toBeLessThan(iface.indexOf('  purgeOtherAccounts('));
  // The property: from its line to the next property, right after `count`.
  const propStart = returned.indexOf('    hasOtherAccounts:');
  const propEnd = returned.indexOf('    purgeOtherAccounts(');
  expect(propStart).toBeGreaterThan(returned.indexOf('    count:'));
  expect(propEnd).toBeGreaterThan(propStart);
  const property = returned.slice(propStart, propEnd);
  const allowed = new Set([...member.split('\n'), ...property.split('\n')]);
  for (const l of added) expect(allowed.has(l), `added line outside hasOtherAccounts: ${JSON.stringify(l)}`).toBe(true);
  // Read-only: it removes and writes nothing, and calls no purge.
  expect(property).not.toMatch(/removeRaw|setRaw|removeAll|purge|\.setItem|\.removeItem/);
});

it('D16: S-01\'s purgeDraftsAfterSignIn, purgeOtherAccountsAfterSignIn, submitSignIn and browserStorage are as at stage-1-base', () => {
  const base = git('show', `${BASE}:app/(public)/login/LoginClient.tsx`);
  const head = readFileSync('app/(public)/login/LoginClient.tsx', 'utf8');
  for (const name of ['purgeDraftsAfterSignIn', 'purgeOtherAccountsAfterSignIn', 'submitSignIn', 'browserStorage']) {
    expect(functionText(head, name), name).toBe(functionText(base, name));
  }
  expect(head).toContain('.purgeOtherAccounts(');
});
