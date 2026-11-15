/**
 * Styles entry: the kit's form stylesheets, as one module. A styles entry (components/ui/<part>Styles.ts) holds only
 * stylesheet imports, and each sheet it names has that entry as its one importer. Why: Turbopack serves two sheets that
 * different entries (layouts, pages, not-found pages) load as separate files, so a page that imports one sheet of a
 * pair without the other cuts their file in two for every page. That sheets reached only through one module are served
 * as one file is measured, not derived from the bundler: it held in every build of this kit, while the font sheet,
 * Icon.css and globals.css, loaded by the same entries, are two files. The built page is the check: the stylesheet
 * count and contents in e2e/invitation-name-transfer.spec.ts and the byte limits there and in
 * e2e/first-visit-transfer.spec.ts. Every kit form part imports this module; a file outside components/ui/ whose native
 * element wears a kit class imports the entry ('@/components/ui/formStyles'), never a sheet (ruling X-6). The import
 * rules are checked by __tests__/lint/kit-styles-entries.test.ts.
 */
import './TextInput.css';
import './StatusRegion.css';
import './Checkbox.css';
import './ErrorSummary.css';
