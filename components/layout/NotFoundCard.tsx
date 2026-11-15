import Link from 'next/link';
import { GATE_LOOK } from '@/lib/errors/frame';
import { NOT_FOUND_COPY } from '@/lib/errors/not-found/copy';
import { SHELL_COPY } from '@/lib/shell/copy';

/**
 * The card both S-31 pages show (SRS 7.1.5; UX-05; M-27): "Page not found", the one sentence that serves a missing page, a
 * missing record and a person who is not a member of the organisation in the address, and one way on: the home page for a
 * signed-in person, Sign in for anyone else (plan 1B Task 14, Interfaces). `signedIn` is the caller's: app/not-found.tsx
 * reads it on the server, app/(authenticated)/not-found.tsx is inside the signed-in layout. Nothing else reaches it and it
 * reads nothing from the request, so it can never tell a non-member that an organisation exists. It renders no main landmark,
 * no id and no dialog: app/not-found.tsx puts it in the gate frame inside its own main, and app/(authenticated)/not-found.tsx
 * lets the signed-in layout's main hold it. It is the gate frame's card, drawn with `lib/errors/frame.ts`'s inline role-token
 * styles, so it adds no stylesheet to the pages whose first load lists it. M-27's words live in
 * `lib/errors/not-found/copy.ts` and nowhere else, so the answers for the two pages stay identical.
 */
export default function NotFoundCard({ signedIn }: { signedIn: boolean }) {
  return (
    <div data-gate-card="" style={GATE_LOOK.card}>
      <h1 style={GATE_LOOK.heading}>{NOT_FOUND_COPY.heading}</h1>
      <p style={GATE_LOOK.paragraph}>{NOT_FOUND_COPY.body}</p>
      <p>{signedIn ? <Link href="/">{NOT_FOUND_COPY.home}</Link> : <Link href="/login">{SHELL_COPY.public.signIn}</Link>}</p>
    </div>
  );
}
