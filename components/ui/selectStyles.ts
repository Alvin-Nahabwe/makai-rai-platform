/**
 * Styles entry: the select's rules, after the kit's form rules.
 * A styles entry holds only stylesheet imports, and the sheets it names have it as their one importer, so the bundler
 * cannot serve them in separate files (components/ui/formStyles.ts says why). A file outside components/ui/ that needs
 * these rules imports this module, never the sheets (ruling X-6).
 */
import './formStyles';
import './Select.css';
