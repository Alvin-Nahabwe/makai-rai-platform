import Link from 'next/link';
import { ERRORS_COPY } from '@/lib/errors/copy';

/**
 * The card both S-31 pages show (SRS 7.1.5; UX-05; M-27): "Page not found", the one sentence that serves a missing page, a
 * missing record and a person who is not a member of the organisation in the address, and a link home. It takes no props and reads
 * nothing from the request, so it can never tell a non-member that an organisation exists. It renders no main landmark, no id and
 * no dialog: app/not-found.tsx puts it inside its own main, and app/(authenticated)/not-found.tsx lets the signed-in layout's main
 * hold it. M-27's words live in `lib/errors/copy.ts` and nowhere else, so the answers for the two pages stay identical.
 */
export default function NotFoundCard() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>{ERRORS_COPY.notFound.heading}</h1>
        <p>{ERRORS_COPY.notFound.body}</p>
        <p className="auth-footer">
          <Link href="/">{ERRORS_COPY.notFound.home}</Link>
        </p>
      </div>
    </div>
  );
}
