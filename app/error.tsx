'use client';

import { ERRORS_COPY } from '@/lib/errors/copy';
import { pageTitle } from '@/lib/ui/title';

/**
 * The page a person sees when a page fails on the server (NFR-OBS-05, NFR-AVL-04). It says what did not happen,
 * what is safe and what to do (SRS 7.5.7, line 2544), and shows the support reference to read out.
 *
 * It renders fixed words and the reference, and never `error.message` or the stack (H-S5): for a server-side
 * failure Next hands this component an error whose message is generic and whose `digest` matches the server's own
 * log line, but a value thrown in a client component arrives as it was thrown. The reference is `error.digest`,
 * shown only when it is a short string of letters, digits, `-` and `_`. An error with none is a failure in the
 * browser, where "the server had a problem" would be untrue, so it gets its own words and no reference (owner
 * default B41).
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

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const reference = supportReferenceOf(error);
  return (
    <main id="main-content" tabIndex={-1} className="public-layout">
      {/* React 19 hoists this into the head: a failed page's own metadata never resolved, so the tab still names the screen. */}
      <title>{pageTitle(ERRORS_COPY.titles.error)}</title>
      <div className="auth-card" style={{ maxWidth: 520, margin: '3rem auto' }}>
        <h1>This page could not be loaded</h1>
        {reference === null ? (
          <p>
            {'Something went wrong while showing this page. Answers you typed on this device are kept. Try again. If it keeps happening, write to MAK-AI through Help and contact.'}
          </p>
        ) : (
          <>
            <p>
              {`The server had a problem, so nothing on this page was changed. Answers you typed on this device are kept. Try again in a minute. If it keeps happening, write to MAK-AI through Help and contact and give this support reference: ${reference}.`}
            </p>
            <p>{`Support reference: ${reference}`}</p>
          </>
        )}
        <button type="button" className="btn btn--primary" onClick={() => retry()}>
          Try again
        </button>
      </div>
    </main>
  );
}
