import Link from 'next/link';
import { openRegistrationEnabled } from '@/lib/auth/openRegistration';
import RegisterClient from './RegisterClient';

/**
 * Server wrapper, so the page tells the truth about whether it will work.
 *
 * `PLAN.md:217` rules registration invite-gated until T3, and
 * `app/api/auth/register/route.ts` now enforces that with a 403. Without this
 * wrapper the form would still render and still submit — the visitor would fill
 * in their name, their institution and a password, press the button, and be
 * refused. Showing someone a form that cannot succeed is its own defect,
 * separate from the security one.
 *
 * The flag is read HERE, on the server, from the same helper the route uses, so
 * the page and the endpoint cannot disagree. A `NEXT_PUBLIC_` copy would be a
 * second source of truth and a way for them to drift.
 *
 * Same shape as `app/(public)/invitations/[token]/`: a server page that decides,
 * a client component that does the interactive part.
 */
export default function RegisterPage() {
  if (openRegistrationEnabled()) return <RegisterClient />;

  return (
    <div className="auth-card">
      <h1>Registration is by invitation</h1>
      <p>
        Accounts on this platform are created from an invitation, not by signing
        up. If your institution is already here, ask a colleague with an owner or
        admin role to invite your email address — you will get a link that sets
        up your account.
      </p>
      <p>
        If your institution is not on the platform yet, contact the team that
        runs it to arrange access.
      </p>
      <p className="auth-footer">
        <Link href="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
