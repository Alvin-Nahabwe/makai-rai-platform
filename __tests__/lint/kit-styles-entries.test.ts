import { describe, expect, it } from 'vitest';
import { repoFiles } from './helpers/repo-files';
import {
  KIT, SOURCE_EXT, entryBody, entryFiles, insteadOf, isKitSheet, read, resolveSpec, sheetsOfEntries, specifiers,
} from './helpers/kit-styles';

/**
 * NFR-PERF-02 (SRS line 3195): the kit's stylesheets cannot be cut into more files than they are (the lane rulings X-6
 * and L6-2 of follow-up C). Turbopack's default CSS chunking keeps two stylesheets in one built file only while exactly
 * the same entries (layouts, pages, not-found pages) load both, so a page that loads one sheet of a joined pair without
 * the other splits the file for every page: one more request on S-04's first visit.
 *
 *  (a) X-6: no file outside components/ui/ imports a kit stylesheet. It imports the styles entry instead
 *      (`import '@/components/ui/formStyles';`), or the kit component. Scanned: every .ts, .tsx, .js, .jsx, .mjs and
 *      .cjs file under app/, components/ (but components/ui/), lib/ and scripts/, and the root's own; every import form
 *      (`from '…'`, a bare `import '…'`, `import('…')`, `require('…')`) by alias, by relative path, or any path naming
 *      components/ui/; and every stylesheet outside the kit for an `@import` of a kit sheet.
 *  (b) L6-2: a styles entry, `components/ui/<part>Styles.ts`, holds only imports of stylesheets and of other styles
 *      entries, and comments; each sheet it names exists and has exactly one importer in the repository's source, that
 *      entry; so no kit component imports a sheet an entry names.
 *
 * The importer scan reads the repository's files (tracked and untracked, .gitignore applied) except __tests__/ and e2e/,
 * which are not bundled and which hold the fixture strings below.
 */

const SCANNED_DIRS = ['app/', 'components/', 'lib/', 'scripts/'];

/** The files X-6 governs: source outside the kit, and stylesheets outside the kit. */
function outsideKitFiles(files: readonly string[]): string[] {
  return files.filter((f) => !f.startsWith(`${KIT}/`) && (
    (SOURCE_EXT.test(f) && (SCANNED_DIRS.some((d) => f.startsWith(d)) || !f.includes('/'))) || f.endsWith('.css')
  ));
}

/** Each X-6 offence in `files` (path and text), with the line to write instead. */
function x6Offences(files: ReadonlyArray<{ path: string; src: string }>, sheetEntry: Map<string, string>): string[] {
  return files.flatMap(({ path, src }) => specifiers(path, src)
    .map((s) => ({ ...s, target: resolveSpec(path, s.spec) }))
    .filter((s) => isKitSheet(s.target))
    .map((s) => `${path}: ${s.form} '${s.spec}' imports ${s.target}; ${insteadOf(s.target as string, sheetEntry)}`));
}

/** The files whose import of any form, or `@import`, resolves to `sheet`. */
function importersOf(sheet: string, files: ReadonlyArray<{ path: string; src: string }>): string[] {
  return files.filter(({ path, src }) => specifiers(path, src).some((s) => resolveSpec(path, s.spec) === sheet)).map((f) => f.path);
}

const withText = (paths: readonly string[]) => paths.map((path) => ({ path, src: read(path) }));
const bundledSource = () => withText(repoFiles().filter((f) => (SOURCE_EXT.test(f) || f.endsWith('.css'))
  && !f.startsWith('__tests__/') && !f.startsWith('e2e/') && !f.startsWith('node_modules/')));

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
    ];
    for (const [path, src] of caught) expect(x6Offences([{ path, src }], sheetEntry), `${path}: ${src}`).toHaveLength(1);
    expect(x6Offences([{ path: 'components/findings/A.tsx', src: `import '@/components/ui/TextInput.css';` }], sheetEntry)[0])
      .toMatch(/write import '@\/components\/ui\/formStyles'; instead$/);
    expect(x6Offences([{ path: 'components/x/B.tsx', src: `import '@/components/ui/PageHeader.css';` }], sheetEntry)[0])
      .toMatch(/write import '@\/components\/ui\/pageHeaderStyles'; instead$/);
    // Not offences: the entry itself, the kit component, a stylesheet of another folder, a module whose name only ends alike.
    for (const [path, src] of [
      ['components/findings/A.tsx', `import '@/components/ui/formStyles';`],
      ['components/findings/A.tsx', `import { TextInput } from '@/components/ui/TextInput';`],
      ['components/layout/A.tsx', `import './shell.css';`],
      ['components/x/A.tsx', `import '@/components/uiextra/Button.css';`],
    ] as const) expect(x6Offences([{ path, src }], sheetEntry), src).toEqual([]);
  });

  it('(lint, not vacuous) the scan reads app, components outside the kit, lib, scripts, the root, and the stylesheets outside the kit', () => {
    const files = outsideKitFiles(repoFiles());
    for (const f of ['app/layout.tsx', 'components/layout/Rail.tsx', 'lib/ui/copy.ts', 'proxy.ts', 'app/globals.css', 'components/layout/shell.css']) {
      expect(files, f).toContain(f);
    }
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(files.filter((f) => f.startsWith(`${KIT}/`))).toEqual([]);
  });

  it('a planted import of a kit sheet in a page is found', () => {
    const planted = { path: 'app/(public)/login/page.tsx', src: `${read('app/(public)/login/page.tsx')}\nimport '@/components/ui/Checkbox.css';\n` };
    expect(x6Offences([planted], sheetsOfEntries())).toEqual([
      "app/(public)/login/page.tsx: bare '@/components/ui/Checkbox.css' imports components/ui/Checkbox.css; write import '@/components/ui/formStyles'; instead",
    ]);
  });

  it('X-6: no file outside components/ui/ imports a kit stylesheet', () => {
    expect(x6Offences(withText(outsideKitFiles(repoFiles())), sheetsOfEntries())).toEqual([]);
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
    const wrong = [...entries].flatMap((entry) => {
      const body = entryBody(read(entry));
      return [
        ...body.other.map((line) => `${entry}: holds more than imports: ${line}`),
        ...body.imports.flatMap((spec) => {
          const target = resolveSpec(entry, spec) as string;
          if (spec.endsWith('.css')) return repoFiles().includes(target) ? [] : [`${entry}: names ${spec}, which does not exist`];
          return entries.has(target) ? [] : [`${entry}: imports ${spec}, which is not a styles entry`];
        }),
      ];
    });
    expect(wrong).toEqual([]);
  });

  it('a planted second importer of an entry\'s sheet is found', () => {
    const sheet = 'components/ui/Checkbox.css';
    const planted = [...bundledSource(), { path: 'components/ui/Checkbox.tsx', src: `import './Checkbox.css';\n` }];
    expect(importersOf(sheet, planted).sort()).toEqual(['components/ui/Checkbox.tsx', 'components/ui/formStyles.ts']);
  });

  it('every sheet a styles entry names has exactly one importer in the repository\'s source, that entry', () => {
    const source = bundledSource();
    const sheetEntry = sheetsOfEntries();
    expect(sheetEntry.size).toBeGreaterThanOrEqual(9);   // the entries name the sheets, so the check is not vacuous
    const wrong = [...sheetEntry].flatMap(([sheet, entry]) => {
      const importers = importersOf(sheet, source);
      return importers.length === 1 && importers[0] === entry ? [] : [`${sheet}: imported by ${importers.join(', ') || 'nothing'}; only ${entry} may import it`];
    });
    expect(wrong).toEqual([]);
  });

  it('no kit component imports a sheet a styles entry names, and every entry has an importer', () => {
    const source = bundledSource();
    const sheetEntry = sheetsOfEntries();
    const kitParts = source.filter((f) => f.path.startsWith(`${KIT}/`) && !sheetEntry.has(f.path) && !/Styles\.ts$/.test(f.path));
    const offences = kitParts.flatMap(({ path, src }) => specifiers(path, src)
      .map((s) => resolveSpec(path, s.spec))
      .filter((t): t is string => t !== null && sheetEntry.has(t))
      .map((t) => `${path} imports ${t}; ${insteadOf(t, sheetEntry)}`));
    expect(offences).toEqual([]);
    const unused = entryFiles().filter((entry) => !source.some(({ path, src }) => path !== entry
      && specifiers(path, src).some((s) => resolveSpec(path, s.spec) === entry)));
    expect(unused).toEqual([]);
  });
});
