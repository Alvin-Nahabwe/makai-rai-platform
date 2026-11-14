/**
 * Styles entry: the button's and the dialog's rules. Every route loads both: the root not-found page (app/not-found.tsx)
 * mounts the idle warning (components/layout/IdleWarning.tsx), which imports Button and Dialog. As one entry they are one
 * built file on every page, and no page loads a rule it did not load before. If the not-found page ever stops reaching
 * Dialog.css (the idle warning loaded late), pages that draw a button would carry the dialog's rules for nothing: split
 * this entry again then, and measure.
 * A styles entry holds only stylesheet imports, and the sheets it names have it as their one importer, so the bundler
 * cannot serve them in separate files (components/ui/formStyles.ts says why). A file outside components/ui/ that needs
 * these rules imports this module, never the sheets (ruling X-6).
 */
import './Button.css';
import './Dialog.css';
