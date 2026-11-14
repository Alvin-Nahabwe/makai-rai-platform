/**
 * Styles entry: the button's and the dialog's rules. Every route loads both: the root not-found page (app/not-found.tsx)
 * mounts the idle warning (components/layout/IdleWarning.tsx), which imports Button and Dialog. As one entry they are one
 * built file on every page, and no page loads a rule it did not load before. If the not-found page ever stops reaching
 * the Dialog component (the idle warning loaded late), pages that draw a button would carry the dialog's rules for
 * nothing: split this entry again then, and measure (__tests__/lint/invitation-kit-sheets.test.ts fails when it does).
 * Button.tsx and Dialog.tsx both import this entry; a file outside components/ui/ that needs .ui-button imports it too.
 * What a styles entry is, and why the kit has them: components/ui/formStyles.ts.
 */
import './Button.css';
import './Dialog.css';
