import type { Metadata } from 'next';
import { headers } from 'next/headers';
import IdleWarning from '@/components/layout/IdleWarning';
import NotFoundCard from '@/components/layout/NotFoundCard';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';

export const metadata: Metadata = { title: 'Not found - MAK-AI RAI Platform' };

/**
 * S-31, "Not found or no access" (SRS 7.1.5; UX-05; M-27).
 *
 * One page for a missing page, a missing record and a person who is not a
 * member of the organisation in the address, with the same words for all
 * three (components/layout/NotFoundCard.tsx holds them). It takes no props and
 * echoes nothing from the request: echoing the path, a slug or an
 * organisation name would tell a non-member that the organisation exists. The
 * one thing it reads is the session cookie's two deadlines, through
 * readSessionDeadlines(await headers()), which return numbers about the
 * visitor's own session and nothing about the address. Next sends status 404
 * before streaming starts
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * not-found.md), and this page renders inside the root layout, so the skip
 * link and the footer are on it.
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
 *
 * The main element writes the skip-link target as a literal because this file
 * must not depend on a client component's module; components/layout/SkipLink.tsx
 * exports the same value as MAIN_CONTENT_ID, and a unit test checks every
 * <main> under app/ against it.
 */
export default async function NotFound() {
  const deadlines = await readSessionDeadlines(await headers());
  return (
    <>
      {deadlines ? <IdleWarning idleSeconds={idleLimitSeconds()} {...deadlines} /> : null}
      <main id="main-content" tabIndex={-1} className="public-layout">
        <NotFoundCard />
      </main>
    </>
  );
}
