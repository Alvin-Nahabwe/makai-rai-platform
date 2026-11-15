import { describe, expect, it } from 'vitest';
import { repoFiles } from './helpers/repo-files';
import {
  KIT, bundledFiles, isBundled, entryBody, entryFiles, insteadOf, isKitSheet, read, resolveOf, resolveSpec, sheetsOfEntries,
  specifiers,
} from './helpers/kit-styles';

/**
 * NFR-PERF-02 (SRS line 3195), the lane rulings X-6 and L6-2 of follow-up C: the kit's stylesheets reach pages through
 * styles entries (components/ui/<part>Styles.ts), so that sheets the bundler serves as one file keep the same
 * importers. Measured, not derived: in every build so far a page that loaded one sheet of a joined pair without the
 * other split the file in two for every page (one more request on S-04's first visit), and sheets that arrive only
 * through one entry were one file (components/ui/formStyles.ts). The built page is checked by
 * e2e/invitation-name-transfer.spec.ts (its stylesheet count and contents) and by the byte limits of that spec and
 * e2e/first-visit-transfer.spec.ts.
 *
 *  (a) X-6: no file outside components/ui/ imports a kit stylesheet. It imports the styles entry instead
 *      (`import '@/components/ui/formStyles';`), or the kit component. Scanned: every file a bundle can include outside
 *      the kit (each .ts, .tsx, .js, .jsx, .mjs, .cjs, .mts, .cts and .css file the repository holds, wherever it is, but
 *      __tests__/ and e2e/); every import form (`from '…'`, a bare `import '…'`, `import('…')` with any arguments,
 *      `require('…')`, a comment allowed before the string, a `?query` or `#fragment` allowed after it) by alias, by
 *      relative path, or any path naming components/ui/; and every stylesheet's `@import`, in any spelling.
 *  (b) L6-2: a styles entry holds only imports of stylesheets and of other styles entries, and comments; each sheet it
 *      names exists and has exactly one importer in the same files, that entry; every entry is imported.
 *  A relative or `@/` import that names no file fails the scan ("cannot resolve"), unless it sits inside a comment
 *  or a string (scripts/vocabulary/generate.mjs writes one out as text).
 *  Out of reach: a specifier built at run time (helpers/kit-styles.ts says which).
 *
 * __tests__/ and e2e/ are not bundled, and they hold the fixture strings below.
 */

/** The files X-6 governs: every file a bundle can include, outside the kit. */
const outsideKitFiles = (files: readonly string[]) => files.filter((f) => !f.startsWith(`${KIT}/`));

type Text = { path: string; src: string };

/** Each X-6 offence in `files` (path and text), with the line to write instead. */
function x6Offences(files: readonly Text[], sheetEntry: Map<string, string>): string[] {
  return files.flatMap(({ path, src }) => specifiers(path, src)
    .map((s) => ({ ...s, target: resolveOf(path, s) }))
    .filter((s) => isKitSheet(s.target))
    .map((s) => `${path}: ${s.form} '${s.spec}' imports ${s.target}; ${insteadOf(s.target as string, sheetEntry)}`));
}

/** For every path any of `files` imports, in any form, the files that import it. One pass. */
function importIndex(files: readonly Text[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const { path, src } of files) {
    for (const target of new Set(specifiers(path, src).map((s) => resolveOf(path, s)))) {
      if (target !== null) index.set(target, [...(index.get(target) ?? []), path]);
    }
  }
  return index;
}

const withText = (paths: readonly string[]): Text[] => paths.map((path) => ({ path, src: read(path) }));
/** Every file a bundle can include, the kit's own among them, with its text. */
const bundledSource = () => withText(bundledFiles());

describe('NFR-PERF-02 X-6: no file outside components/ui/ imports a kit stylesheet', () => {
  it('(lint self-test) every import form and path form is caught, a stylesheet @import too, and the message names the entry', () => {
    const sheetEntry = sheetsOfEntries();
    const caught: Array<[string, string]> = [
      ['components/findings/A.tsx', `import '@/components/ui/TextInput.css';`],
      ['components/findings/A.tsx', `import "../ui/Checkbox.css";`],
      ['app/(public)/x/page.tsx', `import '../../../components/ui/ErrorSummary.css';`],
      ['app/(public)/x/page.tsx', 'import `@/components/ui/StatusRegion.css`;'],
      ['lib/x.ts', `import styles from '@/components/ui/Select.css';`],
      ['lib/x.ts', `export * from '@/components/ui/TextArea.css';`],
      ['components/x/B.tsx', `const m = await import('@/components/ui/DateField.css');`],
      ['scripts/x.mjs', `require("../components/ui/Button.css");`],
      ['components/x/B.tsx', `import 'components/ui/PageHeader.css';`],
      ['app/x/x.css', `@import '../../components/ui/Breadcrumb.css';`],
      ['app/x/x.css', `@import url(../../components/ui/Dialog.css);`],
      // Fix round 1 (F2): a comment before the string, a second argument or a trailing comma, a query or a fragment,
      // and CSS's @import with no space or in capitals.
      ['components/x/B.tsx', `const m = await import(/* webpackChunkName: "x" */ '@/components/ui/Callout.css');`],
      ['scripts/x.mjs', `require(/* c */ '../components/ui/Table.css');`],
      ['components/x/B.tsx', `await import('@/components/ui/Callout.css', { with: { type: 'css' } });`],
      ['components/x/B.tsx', `await import('@/components/ui/Callout.css',);`],
      ['components/x/B.tsx', `import '@/components/ui/Checkbox.css?v=1';`],
      ['components/x/B.tsx', `import '@/components/ui/Checkbox.css#x';`],
      ['app/x/x.css', `@import"../../components/ui/Callout.css";`],
      ['app/x/x.css', `@IMPORT '../../components/ui/Callout.css';`],
    ];
    expect(caught.filter(([path, src]) => x6Offences([{ path, src }], sheetEntry).length !== 1).map(([, src]) => src), 'forms not caught').toEqual([]);
    expect(x6Offences([{ path: 'components/findings/A.tsx', src: `import '@/components/ui/TextInput.css';` }], sheetEntry)[0])
      .toMatch(/write import '@\/components\/ui\/formStyles'; instead$/);
    expect(x6Offences([{ path: 'components/x/B.tsx', src: `import '@/components/ui/PageHeader.css';` }], sheetEntry)[0])
      .toMatch(/write import '@\/components\/ui\/pageHeaderStyles'; instead$/);
    // Not offences: the entry itself, the kit component, a stylesheet of another folder, a module whose name only ends alike.
    for (const [path, src] of [
      ['components/findings/A.tsx', `import '@/components/ui/formStyles';`],
      ['components/findings/A.tsx', `import { TextInput } from '@/components/ui/TextInput';`],
      ['components/layout/A.tsx', `import './shell.css';`],
      ['components/x/A.tsx', `import 'some-package/components/uiextra/Button.css';`],
    ] as const) expect(x6Offences([{ path, src }], sheetEntry), src).toEqual([]);
  });

  it('(lint, not vacuous) the scan reads app, components outside the kit, lib, scripts, types, data, the root, and the stylesheets outside the kit', () => {
    const files = outsideKitFiles(bundledFiles());
    for (const f of ['app/layout.tsx', 'components/layout/Rail.tsx', 'lib/ui/copy.ts', 'proxy.ts', 'app/globals.css', 'components/layout/shell.css']) {
      expect(files, f).toContain(f);
    }
    for (const dir of ['scripts/', 'types/', 'data/']) expect(files.some((f) => f.startsWith(dir)), dir).toBe(true);
    expect(files.filter((f) => f.startsWith(`${KIT}/`) || f.startsWith('__tests__/') || f.startsWith('e2e/'))).toEqual([]);
  });

  it('(fix round 1, F1) a source file in a folder nobody listed is read, and so are .mts and .cts files', () => {
    const picked = outsideKitFiles(['hooks/x.ts', 'types/legal.ts', 'data/x.mjs', 'lib/a.mts', 'lib/b.cts', 'app/x.css',
      'components/ui/Button.tsx', 'docs/x.md', '__tests__/lint/x.test.ts', 'e2e/x.spec.ts'].filter(isBundled));
    expect(picked.sort()).toEqual(['app/x.css', 'data/x.mjs', 'hooks/x.ts', 'lib/a.mts', 'lib/b.cts', 'types/legal.ts']);
  });

  it('(fix round 1, F3) a relative or @/ import that names no file fails loudly, unless it is inside a comment or a string', () => {
    expect(() => x6Offences([{ path: 'app/x/page.tsx', src: `import './Missing';` }], sheetsOfEntries()))
      .toThrow('app/x/page.tsx: cannot resolve ./Missing');
    expect(() => x6Offences([{ path: 'app/x/page.tsx', src: `import '@/lib/nothing-here';` }], sheetsOfEntries()))
      .toThrow('app/x/page.tsx: cannot resolve @/lib/nothing-here');
    const src = "// import './Missing';\n/* import '@/gone'; */\nconst code = `import type { X } from './types';`;\nimport './layout';";
    expect(x6Offences([{ path: 'app/page.tsx', src }], sheetsOfEntries())).toEqual([]);
    expect(resolveSpec('app/layout.tsx', './globals.css?inline')).toBe('app/globals.css');
  });

  it('a planted import of a kit sheet in a page is found', () => {
    const planted = { path: 'app/(public)/login/page.tsx', src: `${read('app/(public)/login/page.tsx')}\nimport '@/components/ui/Checkbox.css';\n` };
    expect(x6Offences([planted], sheetsOfEntries())).toEqual([
      "app/(public)/login/page.tsx: bare '@/components/ui/Checkbox.css' imports components/ui/Checkbox.css; write import '@/components/ui/formStyles'; instead",
    ]);
  });

  it('X-6: no file outside components/ui/ imports a kit stylesheet', () => {
    expect(x6Offences(withText(outsideKitFiles(bundledFiles())), sheetsOfEntries())).toEqual([]);
  });
});

describe('NFR-PERF-02: the bundler may not drop a styles entry', () => {
  it('package.json declares no sideEffects field', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect('sideEffects' in pkg, 'package.json must not declare "sideEffects": a styles entry exports nothing, so a bundler '
      + 'told the package has no side effects may drop it and its stylesheets; and follow-up B measured that such a hint '
      + 'already breaks the latin-ext font').toBe(false);
  });
});

describe('NFR-PERF-02 L6-2: each styles entry is the one importer of the sheets it names', () => {
  it('(lint, not vacuous) the entries are found, and the form entry names the four form sheets in their order', () => {
    expect(entryFiles()).toEqual(expect.arrayContaining([
      'components/ui/formStyles.ts', 'components/ui/textAreaStyles.ts', 'components/ui/selectStyles.ts',
      'components/ui/dateFieldStyles.ts', 'components/ui/buttonStyles.ts', 'components/ui/pageHeaderStyles.ts',
    ]));
    expect(entryBody(read('components/ui/formStyles.ts')).imports).toEqual(['./TextInput.css', './StatusRegion.css', './Checkbox.css', './ErrorSummary.css']);
  });

  it('(lint self-test) an entry with anything but imports and comments is caught', () => {
    expect(entryBody(`/** x */\nimport './A.css';\n// y\nimport './bStyles';\n`)).toEqual({ imports: ['./A.css', './bStyles'], other: [] });
    expect(entryBody(`import './A.css';\nexport const x = 1;\n`).other).toEqual(['export const x = 1;']);
    expect(entryBody(`import { x } from './A';\n`).other).toHaveLength(1);
    expect(entryBody(`import '@/components/ui/A.css';\n`).other).toHaveLength(1);
  });

  it('a styles entry holds only imports of sheets that exist and of other styles entries, and comments', () => {
    const entries = new Set(entryFiles());
    const files = new Set(repoFiles());
    const wrong = [...entries].flatMap((entry) => {
      const body = entryBody(read(entry));
      return [
        ...body.other.map((line) => `${entry}: holds more than imports: ${line}`),
        ...body.imports.flatMap((spec) => {
          const target = resolveSpec(entry, spec, true) as string;
          if (spec.endsWith('.css')) return files.has(target) ? [] : [`${entry}: names ${spec}, which does not exist`];
          return entries.has(target) ? [] : [`${entry}: imports ${spec}, which is not a styles entry`];
        }),
      ];
    });
    expect(wrong).toEqual([]);
  });

  /** Each entry sheet whose importers are not exactly its entry, with what to write instead. */
  function secondImporters(source: readonly Text[]): string[] {
    const index = importIndex(source);
    return [...sheetsOfEntries()].flatMap(([sheet, entry]) => {
      const importers = index.get(sheet) ?? [];
      if (importers.length === 1 && importers[0] === entry) return [];
      return [`${sheet}: imported by ${importers.join(', ') || 'nothing'}; only ${entry} may import it: in each other file, `
        + `${insteadOf(sheet, sheetsOfEntries())}`];
    });
  }

  it('a planted second importer of an entry\'s sheet is found, and the message names the entry to import', () => {
    const planted = [...bundledSource().filter((f) => f.path !== 'components/ui/Checkbox.tsx'),
      { path: 'components/ui/Checkbox.tsx', src: `import './Checkbox.css';\n` }];
    expect(secondImporters(planted)).toEqual(["components/ui/Checkbox.css: imported by components/ui/formStyles.ts, "
      + "components/ui/Checkbox.tsx; only components/ui/formStyles.ts may import it: in each other file, write import "
      + "'@/components/ui/formStyles'; instead"]);
  });

  it('every sheet a styles entry names has exactly one importer in the files a bundle can include, that entry', () => {
    expect(secondImporters(bundledSource())).toEqual([]);
  });

  it('every styles entry is imported by a file other than itself', () => {
    const index = importIndex(bundledSource());
    expect(entryFiles().filter((entry) => !(index.get(entry) ?? []).some((f) => f !== entry))).toEqual([]);
  });
});
