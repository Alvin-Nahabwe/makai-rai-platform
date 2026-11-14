/**
 * The words of the not-found card and of the two pages that show it (S-31; audit A 13 to 17). They live apart from
 * `lib/errors/copy.ts`, which `app/error.tsx` (a client file) puts on every page: only server components read this module
 * (`components/layout/NotFoundCard.tsx`, `app/not-found.tsx`, `app/(authenticated)/not-found.tsx`), so no browser loads it.
 */

const HEADING = 'Page not found';

export const NOT_FOUND_COPY = Object.freeze({
  title: HEADING,
  heading: HEADING,
  body: 'We cannot find this page, or you do not have access to it. If someone sent you this link, ask them to check it or to invite you.',
  home: 'Go to your home page',
});
