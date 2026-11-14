/**
 * Styles entry: the kit's form stylesheets, as one module. A styles entry holds only stylesheet imports, and each sheet
 * it names has that entry as its one importer. Turbopack's default CSS chunking keeps two stylesheets in one built file
 * only while exactly the same entries (layouts, pages, not-found pages) load both; sheets that only ever arrive through
 * one module always have the same entries, so they are never cut apart. Every kit form part imports this module; a file
 * outside components/ui/ whose native element wears a kit form class imports '@/components/ui/formStyles' too, never
 * one of these sheets (ruling X-6). Both rules are checked by __tests__/lint/kit-styles-entries.test.ts.
 */
import './TextInput.css';
import './StatusRegion.css';
import './Checkbox.css';
import './ErrorSummary.css';
