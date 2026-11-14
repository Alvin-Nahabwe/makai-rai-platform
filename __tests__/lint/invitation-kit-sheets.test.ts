import { readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/repo-files';
import { ENTRY_NAME, isKitSheet, read, resolveSpec, specifiers } from './helpers/kit-styles';

/**
 * NFR-PERF-02 (SRS line 3195), lane ruling X-7 of follow-up C: the kit stylesheets S-04 (the invitation page) loads on
 * its first visit cannot be cut into more files. Turbopack's default CSS chunking keeps two stylesheets in one built file
 * only while exactly the same entries load both; a sheet that arrives only through a styles entry
 * (components/ui/<part>Styles.ts, one importer per sheet: __tests__/lint/kit-styles-entries.test.ts) always has the same
 * entries as its partners, so its file cannot split.
 *
 * This walks what S-04's first visit loads: the route's special files (each layout, the page, and the error, not-found
 * and global-error files of every segment above it, read from the folders, not listed by hand) and everything they
 * import statically: `import … from`, `export … from` and a bare `import '…'`, stylesheets and their `@import` included.
 * `import()` and `require()` are not followed: a module loaded on a press is not part of the first visit. Each kit sheet
 * reached must be reached only through a styles entry, except the sheets pinned below with their reason. The set of kit
 * sheets is pinned whole, so a new one reaching S-04 fails here until it is put in an entry or its reason is written.
 *
 * What this cannot see: how the bundler groups the files. Bytes and the built page's stylesheet count are measured by
 * e2e/invitation-name-transfer.spec.ts (which pins the count) and e2e/first-visit-transfer.spec.ts.
 */

const ROUTE = ['app', 'app/(public)', 'app/(public)/invitations', 'app/(public)/invitations/[token]'];
const SPECIAL = /^(layout|template|error|loading|not-found|global-error)\.(tsx|ts|jsx|js)$/;

/** The files Next.js renders for S-04's segments: each segment's special files, and the leaf's page. */
function routeRoots(): string[] {
  return ROUTE.flatMap((dir) => readdirSync(posix.join(ROOT, dir))
    .filter((f) => SPECIAL.test(f) || (dir === ROUTE[ROUTE.length - 1] && /^page\.(tsx|ts|jsx|js)$/.test(f)))
    .map((f) => posix.join(dir, f)));
}

const FOLLOWED = new Set(['from', 'bare', '@import']);

/** Every file reached from `roots` by static imports, with the files that import each one. */
function importers(roots: readonly string[]): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>(roots.map((r) => [r, new Set<string>()]));
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (!/\.(tsx?|jsx?|mjs|css)$/.test(file)) continue;
    for (const { spec, form } of specifiers(file, read(file))) {
      if (!FOLLOWED.has(form)) continue;
      const target = resolveSpec(file, spec);
      if (target === null) continue;
      if (!by.has(target)) { by.set(target, new Set()); queue.push(target); }
      by.get(target)!.add(file);
    }
  }
  return by;
}

/** Kit sheets S-04 may reach other than through a styles entry, each with its reason. */
const PINNED: Readonly<Record<string, string>> = {
  'components/ui/Icon.css': 'the root layout reaches it (OfflineBanner, Banner, Icon), so every entry loads it, and it shares the next/font sheet\'s file',
};

/** Every kit sheet S-04's first visit loads today. A change here is a decision: put the sheet in a styles entry, or pin it. */
const S04_KIT_SHEETS = [
  'components/ui/Button.css', 'components/ui/Checkbox.css', 'components/ui/Dialog.css', 'components/ui/ErrorSummary.css',
  'components/ui/Icon.css', 'components/ui/StatusRegion.css', 'components/ui/TextInput.css',
];

describe('NFR-PERF-02 X-7: S-04 loads kit stylesheets only through styles entries', () => {
  it('(walker, not vacuous) the roots are the route\'s files, and the walk follows a bare import, a stylesheet and a styles entry', () => {
    expect(routeRoots().sort()).toEqual(['app/(public)/invitations/[token]/page.tsx', 'app/(public)/layout.tsx', 'app/error.tsx',
      'app/global-error.tsx', 'app/layout.tsx', 'app/not-found.tsx']);
    const reached = importers(routeRoots());
    expect(reached.has('app/(public)/invitations/[token]/AcceptInvitationClient.tsx')).toBe(true);
    expect(reached.has('app/globals.css')).toBe(true);   // a bare import of a stylesheet
    expect(reached.get('components/ui/TextInput.css')).toEqual(new Set(['components/ui/formStyles.ts']));
  });

  it('the anchor: the root layout reaches Icon.css', () => {
    expect(importers(['app/layout.tsx']).has('components/ui/Icon.css')).toBe(true);
  });

  it('(lint self-test) a kit sheet reached from outside a styles entry is reported', () => {
    expect(offences(new Map([
      ['components/ui/Checkbox.css', new Set(['components/ui/formStyles.ts', 'components/ui/Checkbox.tsx'])],
      ['components/ui/TextInput.css', new Set(['components/ui/formStyles.ts'])],
      ['components/ui/Icon.css', new Set(['components/ui/Icon.tsx'])],
    ]))).toEqual(['components/ui/Checkbox.css is reached through components/ui/Checkbox.tsx, not only a styles entry']);
  });

  it('every kit sheet S-04 loads arrives only through a styles entry, but the pinned ones', () => {
    expect(offences(importers(routeRoots()))).toEqual([]);
  });

  it('the kit sheets S-04 loads are exactly these', () => {
    const sheets = [...importers(routeRoots()).keys()].filter(isKitSheet).sort();
    expect(sheets, 'a kit sheet was added to or left S-04: put a new one in a styles entry (components/ui/<part>Styles.ts) '
      + 'or pin it in PINNED with its reason, then update this list').toEqual(S04_KIT_SHEETS);
    for (const sheet of Object.keys(PINNED)) expect(S04_KIT_SHEETS, `${sheet} is pinned but S-04 no longer loads it`).toContain(sheet);
  });
});

function offences(reached: Map<string, Set<string>>): string[] {
  return [...reached].filter(([file]) => isKitSheet(file) && !(file in PINNED)).flatMap(([sheet, from]) => {
    const others = [...from].filter((f) => !ENTRY_NAME.test(f));
    return others.length === 0 ? [] : [`${sheet} is reached through ${others.join(', ')}, not only a styles entry`];
  });
}
