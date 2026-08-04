import { invitationByToken } from '@/lib/data/preauth';
import { auth } from '@/lib/auth';
import { resolveIdentity, SessionError } from '@/lib/auth/identity';
import AcceptInvitationClient from './AcceptInvitationClient';

/**
 * Public preview + acceptance entry point for an invitation link
 * (Task 8 brief property 5 / D-098). Deliberately NOT gated by
 * `requireIdentity()` — that redirects an anonymous visitor to `/login`
 * before they can see what org or role the link even names, which is the
 * wrong UX for a link whose whole point is to be followed by someone who
 * may not have an account yet.
 *
 * `invitationByToken` fails closed (returns `null` for
 * expired/accepted/unknown, indistinguishably — lib/data/preauth.ts), so an
 * invalid link renders a plain "not found" message rather than leaking
 * which of those three cases it was.
 */
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await invitationByToken(token);

  if (!invitation) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h1>Invitation not found</h1>
          <p className="text-muted">
            This invitation link is invalid or has expired. Ask whoever invited you to send a
            new one.
          </p>
        </div>
      </div>
    );
  }

  // Soft identity check — NOT `requireIdentity()` (see module doc above).
  // Reuses `resolveIdentity`'s fresh-DB-read path directly rather than
  // trusting the session's own claims, for the same reason ADR-0002 gives
  // for every other identity read in this app: a deactivation or session
  // revocation must take effect on THIS request, not survive to the old
  // token's claimed lifetime.
  const session = await auth();
  let viewerEmail: string | null = null;
  if (session?.user?.id) {
    try {
      const identity = await resolveIdentity({
        id: session.user.id,
        sessionEpoch: session.sessionEpoch,
        sessionIssuedAt: session.sessionIssuedAt,
      });
      viewerEmail = identity.email;
    } catch (e) {
      // `SessionError` (invalid/expired/revoked session) is "anonymous" for
      // THIS page — the same case `requireIdentity()` handles by
      // redirecting to /login; there is nowhere to redirect FROM here, so
      // the visitor just sees the anonymous branch below. Anything else is
      // NOT this page's to interpret and must surface loudly, matching
      // `requireIdentity`'s own by-name (never catch-all) handling.
      if (!(e instanceof SessionError)) throw e;
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>You&apos;re invited</h1>
        <p className="text-muted">
          <strong>{invitation.org.name}</strong> has invited <strong>{invitation.email}</strong>{' '}
          to join as <strong>{invitation.role}</strong>.
        </p>
        <AcceptInvitationClient
          token={token}
          invitedEmail={invitation.email}
          orgName={invitation.org.name}
          role={invitation.role}
          viewerEmail={viewerEmail}
        />
      </div>
    </div>
  );
}
