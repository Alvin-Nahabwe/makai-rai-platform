import { readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/repo-files';
import { ENTRY_NAME, isKitSheet, read, resolveOf, specifiers } from './helpers/kit-styles';

/**
 * NFR-PERF-02 (SRS line 3195), lane ruling X-7 of follow-up C: the kit stylesheets S-04 (the invitation page) loads on
 * its first visit arrive through styles entries (components/ui/<part>Styles.ts, one importer per sheet:
 * __tests__/lint/kit-styles-entries.test.ts). In every build measured, sheets that arrive only through one module were
 * one built file (components/ui/formStyles.ts); that is observed, not derived, and the built page is checked by
 * e2e/invitation-name-transfer.spec.ts (its stylesheet count and contents) and the byte limits.
 *
 * This walks what S-04's first visit loads: the route's special files (each segment's layout, template, error, loading,
 * not-found, forbidden, unauthorized and default files, the root's global-error and global-not-found, the leaf's page,
 * and instrumentation-client at the repository root; read from the folders, not listed by hand) and everything they
 * import statically: `import … from`, `export … from` and a bare `import '…'`, stylesheets and their `@import` included.
 * `import()` and `require()` are not followed. That is right for a module loaded inside a handler, and wrong for a
 * component loaded with next/dynamic or React.lazy and drawn on first paint, whose stylesheet ships with the first
 * visit: no file of the walk does that today, and a case below fails when one does. Each kit sheet reached must be
 * reached only through a styles entry, except the sheets pinned below with their reason. The set of kit sheets is
 * pinned whole, so a new one reaching S-04 fails here until it is put in an entry or its reason is written.
 *
 * What this cannot see: how the bundler groups the files, and the order of imports (the font sheet with Icon.css
 * depends on it). The built page is the guard for both.
 */

const ROUTE = ['app', 'app/(public)', 'app/(public)/invitations', 'app/(public)/invitations/[token]'];
const SPECIAL = /^(layout|template|error|loading|not-found|forbidden|unauthorized|default|global-error|global-not-found)\.(tsx|ts|jsx|js)$/;
const ROOT_FILES = /^instrumentation-client\.(ts|js)$/;

/** The files Next.js renders for S-04's segments: each segment's special files, the leaf's page, and the root's client instrumentation. */
function routeRoots(): string[] {
  return [
    ...ROUTE.flatMap((dir) => readdirSync(posix.join(ROOT, dir))
      .filter((f) => SPECIAL.test(f) || (dir === ROUTE[ROUTE.length - 1] && /^page\.(tsx|ts|jsx|js)$/.test(f)))
      .map((f) => posix.join(dir, f))),
    ...readdirSync(ROOT).filter((f) => ROOT_FILES.test(f)),
  ];
}

/** Whether a source file loads a component lazily: an import of next/dynamic, or React's lazy. */
function LAZY(file: string, src: string): boolean {
  return specifiers(file, src).some((s) => s.spec === 'next/dynamic')
    || /\bReact\.lazy\s*\(/.test(src) || /import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*['"]react['"]/.test(src);
}

const FOLLOWED = new Set(['from', 'bare', '@import']);

/** Every file reached from `roots` by static imports, with the files that import each one. */
function importers(roots: readonly string[]): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>(roots.map((r) => [r, new Set<string>()]));
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (!/\.(tsx?|jsx?|mjs|cjs|mts|cts|css)$/.test(file)) continue;
    for (const s of specifiers(file, read(file))) {
      if (!FOLLOWED.has(s.form)) continue;
      const target = resolveOf(file, s);
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

  it('(fix round 1, F4) every special file this Next.js renders around a page is a root when it exists', () => {
    const names = ['layout', 'template', 'error', 'loading', 'not-found', 'global-error', 'default', 'forbidden', 'unauthorized',
      'global-not-found'].flatMap((n) => ['tsx', 'ts', 'jsx', 'js'].map((e) => `${n}.${e}`));
    expect(names.filter((n) => !SPECIAL.test(n))).toEqual([]);
    expect(SPECIAL.test('page.tsx') || SPECIAL.test('route.ts') || SPECIAL.test('layout.css')).toBe(false);
  });

  it('the anchor: the root layout reaches Icon.css', () => {
    expect(importers(['app/layout.tsx']).has('components/ui/Icon.css')).toBe(true);
  });

  it('the anchor of components/ui/buttonStyles.ts: the root not-found page reaches the Dialog component', () => {
    expect(importers(['app/not-found.tsx']).has('components/ui/Dialog.tsx'), 'app/not-found.tsx no longer reaches '
      + 'components/ui/Dialog.tsx, so pages that draw a button may now carry the dialog\'s rules for nothing: split '
      + 'components/ui/buttonStyles.ts again (Button.css alone; Dialog.tsx imports Dialog.css through its own entry), and measure')
      .toBe(true);
  });

  it('(fix round 1, F4) no file of the walk loads a component lazily, whose stylesheet the walk would not follow', () => {
    const lazy = [...importers(routeRoots()).keys()].filter((f) => !f.endsWith('.css') && LAZY(f, read(f)));
    expect(lazy, 'these files import next/dynamic or React.lazy: a component drawn on first paint brings its stylesheet '
      + 'with the first visit, so make importers() follow that import() before accepting this').toEqual([]);
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

  it('NFR-PERF-02 (owner, 15 Nov 15:35, lean frame): S-04 loads the frame\'s public sheet only, no auth.css and no signed-in sheet', () => {
    // The door pages' card rules S-04 uses (AuthCard's lead and a form's status line) are in the frame's sheet, and S-04
    // draws the card from components/auth/AuthCardBase.tsx, which imports no stylesheet.
    const sheets = [...importers(routeRoots()).keys()].filter((f) => f.endsWith('.css') && !isKitSheet(f)).sort();
    expect(sheets).toEqual(['app/globals.css', 'components/layout/gate.css']);
  });
});

function offences(reached: Map<string, Set<string>>): string[] {
  return [...reached].filter(([file]) => isKitSheet(file) && !(file in PINNED)).flatMap(([sheet, from]) => {
    const others = [...from].filter((f) => !ENTRY_NAME.test(f));
    return others.length === 0 ? [] : [`${sheet} is reached through ${others.join(', ')}, not only a styles entry`];
  });
}
