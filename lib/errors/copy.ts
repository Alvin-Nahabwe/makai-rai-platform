/**
 * The words of the error page, and nothing else: `app/error.tsx` is a client file that every page loads (ruling T16-18),
 * so a word that only one screen needs does not belong here. The not-found card's words are in
 * `lib/errors/not-found/copy.ts`, which only server components read; the fixed texts of API answers are in
 * `lib/http/api/copy.ts`.
 */

/** True of the draft store as built: `DraftTarget` in `lib/client/drafts.ts` has two kinds, a question's answer and a mitigation. */
const KEPT = 'If you were typing a decision or a mitigation, your text is kept in this browser.';

export const ERRORS_COPY = Object.freeze({
  titles: Object.freeze({ error: 'This page could not be loaded' }),
  error: Object.freeze({
    heading: 'This page could not be loaded',
    tryAgain: 'Try again',
  }),
});

/**
 * The paragraph of the error page (audit A 8 and 9). `hasReference` is true for a failure on the server, whose support reference
 * the page shows below; without one the failure was in the browser. `footer` is false on the page that has no layout (global
 * error), where there is no footer to point at.
 */
export function errorBody(hasReference: boolean, footer: boolean): string {
  if (hasReference) {
    const where = footer ? 'through Help and contact at the bottom of the page.' : 'through Help and contact.';
    return `Something went wrong on our side. Nothing on this page was changed. ${KEPT} Wait a minute, then select Try again. If this keeps happening, contact MAK-AI ${where} Give them the support reference below.`;
  }
  const where = footer ? 'contact MAK-AI. Use the Help and contact link at the bottom of the page.' : 'contact MAK-AI through Help and contact.';
  return `This page did not load. ${KEPT} Select Try again. If this keeps happening, ${where}`;
}

/** The reference line (audit A 10, KEEP). */
export function supportReferenceLine(reference: string): string {
  return `Support reference: ${reference}`;
}
