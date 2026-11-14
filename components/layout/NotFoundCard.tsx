import Link from 'next/link';
import { NOT_FOUND_COPY } from '@/lib/errors/not-found/copy';

/**
 * The card both S-31 pages show (SRS 7.1.5; UX-05; M-27): "Page not found", the one sentence that serves a missing page, a
 * missing record and a person who is not a member of the organisation in the address, and a link home. It takes no props and reads
 * nothing from the request, so it can never tell a non-member that an organisation exists. It renders no main landmark, no id and
 * no dialog: app/not-found.tsx puts it inside its own main, and app/(authenticated)/not-found.tsx lets the signed-in layout's main
 * hold it. M-27's words live in `lib/errors/not-found/copy.ts` and nowhere else, so the answers for the two pages stay identical.
 */
export default function NotFoundCard() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>{NOT_FOUND_COPY.heading}</h1>
        <p>{NOT_FOUND_COPY.body}</p>
        <p className="auth-footer">
          <Link href="/">{NOT_FOUND_COPY.home}</Link>
        </p>
      </div>
    </div>
  );
}
