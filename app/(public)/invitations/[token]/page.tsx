import { invitationByToken } from '@/lib/data/preauth';
import { tryResolveIdentity } from '@/lib/auth/identity';
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
 *
 * Uses `tryResolveIdentity()` (lib/auth/identity.ts), not a direct `auth()`
 * import — fixed at the final Plan 1b review (CRITICAL-1): this page used
 * to import `auth` from `@/lib/auth` directly, which is exactly the raw
 * session ADR-0002 says application code must never touch. The ESLint ban
 * on that import had been silently defeated by a config collision (see
 * eslint.config.mjs), so nothing caught it. `tryResolveIdentity` keeps the
 * same soft-identity behaviour (an invalid/expired/revoked session is
 * "anonymous" here, not an error) without this page ever seeing the token.
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
  // `tryResolveIdentity()` re-checks isActive/sessionEpoch/absolute-age
  // against the database on every call, for the same reason ADR-0002 gives
  // for every other identity read in this app: a deactivation or session
  // revocation must take effect on THIS request, not survive to the old
  // token's claimed lifetime. Returns `null` for "no session" and for every
  // rejection alike (invalid/expired/revoked) — both are "anonymous" for
  // THIS page, the same case `requireIdentity()` handles by redirecting to
  // /login; there is nowhere to redirect FROM here, so the visitor just
  // sees the anonymous branch below.
  const identity = await tryResolveIdentity();
  const viewerEmail = identity?.email ?? null;

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
