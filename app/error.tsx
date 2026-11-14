'use client';

import { ERRORS_COPY, errorBody, supportReferenceLine } from '@/lib/errors/copy';
import { pageTitle } from '@/lib/ui/title';

/**
 * The page a person sees when a page fails on the server (NFR-OBS-05, NFR-AVL-04). It says what did not happen,
 * what is safe and what to do (SRS 7.5.7, line 2544), and shows the support reference to read out.
 *
 * It renders fixed words and the reference, and never `error.message` or the stack (H-S5): for a server-side
 * failure Next hands this component an error whose message is generic and whose `digest` matches the server's own
 * log line, but a value thrown in a client component arrives as it was thrown. The reference is `error.digest`,
 * shown only when it is a short string of letters, digits, `-` and `_`. An error with none is a failure in the
 * browser, where "something went wrong on our side" would be untrue, so it gets its own words and no reference (owner
 * default B41). The words are `lib/errors/copy.ts`'s.
 *
 * Next 16 passes `retry` (re-fetch and re-render the children) in place of the earlier `reset`
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md). The main landmark is
 * written out, id and tab stop included, because the skip link points at `#main-content` on every page.
 */
function supportReferenceOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const digest = (error as Error & { digest?: unknown }).digest;
  return typeof digest === 'string' && /^[\w-]{1,64}$/.test(digest) ? digest : null;
}

/**
 * `footer` is true on every page that has the layout and so a footer with "Help and contact" (the footer is rendered by
 * the root layout, `app/layout.tsx`); the global error page has neither, passes false, and its sentence points at Help
 * and contact without saying where.
 */
export default function ErrorPage({ error, retry, footer = true }: { error: unknown; retry: () => void; footer?: boolean }) {
  const reference = supportReferenceOf(error);
  return (
    <main id="main-content" tabIndex={-1} className="public-layout">
      {/* React 19 hoists this into the head: a failed page's own metadata never resolved, so the tab still names the screen. */}
      <title>{pageTitle(ERRORS_COPY.titles.error)}</title>
      <div className="auth-card" style={{ maxWidth: 520, margin: '3rem auto' }}>
        <h1>{ERRORS_COPY.error.heading}</h1>
        <p>{errorBody(reference !== null, footer)}</p>
        {reference === null ? null : <p>{supportReferenceLine(reference)}</p>}
        {/* A native button: every page loads this boundary, and the kit's Button would add to each page's first load; the
            last-resort page (app/global-error.tsx) loads no global stylesheet for the kit to draw with. */}
        <button type="button" className="btn btn--primary" onClick={() => retry()}>
          {ERRORS_COPY.error.tryAgain}
        </button>
      </div>
    </main>
  );
}
