'use client';

import ErrorPage from './error';

/**
 * Shown when the root layout itself fails. It replaces the layout, so it is a whole document: its own `html` and
 * `body`, and none of the application's styles, fonts or theme script, which are loaded by the layout that just
 * failed. The words, the reference and the Try again button are `app/error.tsx`'s, so the two cannot drift.
 * `color-scheme` lets the browser's own colours follow the operating system's light or dark setting, and the
 * `title` stands in for the layout's metadata, which does not apply here.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
        <title>This page could not be loaded</title>
      </head>
      <body style={{ fontFamily: 'system-ui, sans-serif', lineHeight: 1.5, margin: '2rem auto', maxWidth: '40rem', padding: '0 1rem' }}>
        <ErrorPage error={error} retry={retry} />
      </body>
    </html>
  );
}
