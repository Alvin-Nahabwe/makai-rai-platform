import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import IdleWarning from '@/components/layout/IdleWarning';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';

export const metadata: Metadata = { title: 'Not found - MAK-AI RAI Platform' };

/**
 * S-31, "Not found or no access" (SRS 7.1.5; UX-05; M-27).
 *
 * One page for a missing page, a missing record and a person who is not a
 * member of the organisation in the address, with the same words for all
 * three. It takes no props and echoes nothing from the request: echoing the
 * path, a slug or an organisation name would tell a non-member that the
 * organisation exists. The one thing it reads is the session cookie's two
 * deadlines, through readSessionDeadlines(await headers()), which return
 * numbers about the visitor's own session and nothing about the address.
 * Next sends status 404 before streaming starts
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * not-found.md), and this page renders inside the root layout, so the skip
 * link and the footer are on it.
 *
 * UX-43 says every signed-in page warns before the idle sign-out, and a root
 * not-found replaces the whole route tree below the root layout, so a
 * notFound() thrown inside the signed-in group renders this page and not that
 * group's layout: the warning is rendered here for a signed-in visitor, and
 * only once. A signed-out visitor on an unknown address is the ordinary case,
 * so a null result renders no warning and logs nothing.
 *
 * This is the only not-found or no-access page. There is no forbidden.tsx and
 * no experimental.authInterrupts (owner question B21): an action page opened
 * by address shows M-26 in the page with status 200.
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
        <div className="auth-container">
          <div className="auth-card">
            <h1>Page not found</h1>
            <p>
              We cannot find this page, or you do not have access to it. If someone sent you this link, ask them to
              check it or to invite you.
            </p>
            <p className="auth-footer">
              <Link href="/">Go to your home page</Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
