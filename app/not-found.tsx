import type { Metadata } from 'next';
import { GATE_LOOK } from '@/lib/errors/frame';
import { NOT_FOUND_COPY } from '@/lib/errors/not-found/copy';
import { PRODUCT_NAME, pageTitle } from '@/lib/ui/title';
import { headers } from 'next/headers';
import IdleWarning from '@/components/layout/IdleWarning';
import { MAKAI_LOGO } from '@/components/layout/logos';
import NotFoundCard from '@/components/layout/NotFoundCard';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { tryResolveIdentity } from '@/lib/auth/identity';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';

export const metadata: Metadata = { title: pageTitle(NOT_FOUND_COPY.title) };

/**
 * S-31, "Not found or no access" (SRS 7.1.5; UX-05; M-27).
 *
 * One page for a missing page, a missing record and a person who is not a
 * member of the organisation in the address, with the same words for all
 * three (components/layout/NotFoundCard.tsx holds them). It takes no props and
 * echoes nothing from the request: echoing the path, a slug or an
 * organisation name would tell a non-member that the organisation exists. It
 * reads two things: the visitor's identity, signed in or not (below), and,
 * only when signed in, the session cookie's two deadlines, through
 * readSessionDeadlines(await headers()), which return numbers about the
 * visitor's own session and nothing about the address. Next sends status 404
 * before streaming starts
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * not-found.md), and this page renders inside the root layout, so the skip
 * link and the footer are on it.
 *
 * Whether the visitor is signed in decides the card's one link (home, or Sign
 * in). It comes from tryResolveIdentity(), the soft read app/(gate)/layout.tsx
 * uses: null when there is no valid session, never a redirect; a failure other
 * than the session's (the database down) is thrown, as everywhere else, and
 * becomes the error page (the lead's ruling, 15 November). Nothing of the
 * identity is shown: no name, no address.
 *
 * The page sits in the gate frame's look (plan 1B Task 14, ruling L5-18): the
 * navy column with the MAK-AI logo above the platform's name beside the card, drawn with
 * lib/errors/frame.ts's inline styles and no stylesheet, because every page's
 * first load lists this page's entry (the coordinator's ruling after lane 7's
 * measurement; GateFrame itself would add its sign-out's code and gate.css).
 *
 * This page serves an address that matches no route and a notFound() thrown
 * outside the signed-in group. It does NOT replace the signed-in layout: a
 * notFound() thrown below app/(authenticated)/layout.tsx renders
 * app/(authenticated)/not-found.tsx inside that layout, which already carries
 * the idle warning and the one main landmark. That is why this page alone
 * renders IdleWarning (UX-43: every signed-in page warns before the idle
 * sign-out) and writes its own main: a signed-in visitor on an unknown address
 * has no layout of the group around the page. A signed-out visitor on an
 * unknown address is the ordinary case, so a null result renders no warning
 * and logs nothing.
 *
 * S-31 is these two files only. There is no forbidden.tsx and no
 * experimental.authInterrupts (owner question B21): an action page opened by
 * address shows M-26 in the page with status 200.
 */
export default async function NotFound() {
  const signedIn = (await tryResolveIdentity()) !== null;
  const deadlines = signedIn ? await readSessionDeadlines(await headers()) : null;
  return (
    <>
      {deadlines ? <IdleWarning idleSeconds={idleLimitSeconds()} {...deadlines} /> : null}
      <main id={MAIN_CONTENT_ID} tabIndex={-1}>
        <div data-gate-look="" style={GATE_LOOK.frame}>
          <div style={GATE_LOOK.column}>
            {/* The MAK-AI logo above the platform's name, as GateFrame draws it: decorative beside the name (alt=""), not a link. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- a file already sized for the drawn logo (logos.ts). */}
            <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height} alt=""
              decoding="async" style={GATE_LOOK.logo} />
            <p style={GATE_LOOK.product}>{PRODUCT_NAME}</p>
          </div>
          <div style={GATE_LOOK.area}>
            <NotFoundCard signedIn={signedIn} />
          </div>
        </div>
      </main>
    </>
  );
}
