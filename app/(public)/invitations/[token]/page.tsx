import type { Metadata } from 'next';
import { invitationByToken } from '@/lib/data/preauth';
import { tryResolveIdentity } from '@/lib/auth/identity';
import { currentLegalText } from '@/lib/legal/registry';
import { ACCEPTED_KINDS } from '@/types/legal';
import { formatDay } from '@/lib/format/dates';
import { INVITATION_PAGE_COPY } from '@/lib/invitations/copy';
import { ORG_COPY, roleWithArticle } from '@/lib/org/copy';
import { pageTitle } from '@/lib/ui/title';
import AcceptInvitationClient from './AcceptInvitationClient';

export const metadata: Metadata = { title: pageTitle(ORG_COPY.titles.invitation) };

/**
 * Public preview + acceptance entry point for an invitation link
 * (Task 8 brief property 5 / D-098). Deliberately NOT gated by
 * `requireIdentity()` — that redirects an anonymous visitor to `/login`
 * before they can see what org or role the link even names, which is the
 * wrong UX for a link whose whole point is to be followed by someone who
 * may not have an account yet.
 *
 * `invitationByToken` fails closed (returns `null` for an expired, used,
 * revoked, replaced or unknown token, and for an archived organisation,
 * indistinguishably — lib/data/preauth.ts), so an unusable link renders its heading and M-23
 * alone: no organisation, role or inviter name (FR-ACC-01, W-11 note 1).
 * Otherwise S-04 (W-11): who invited the person, as what, until when, and
 * the client's three branches by who is signed in.
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
          <h1>{INVITATION_PAGE_COPY.unusableHeading}</h1>
          <p>{INVITATION_PAGE_COPY.unusable}</p>
        </div>
      </div>
    );
  }

  // Soft identity check — NOT `requireIdentity()` (see module doc above).
  // `tryResolveIdentity()` re-checks isActive/sessionEpoch/absolute-age
  // against the database on every call; `null` for no session and for every
  // rejection alike, both "anonymous" for THIS page.
  const identity = await tryResolveIdentity();
  const expiresOn = invitation.expiresAt.toISOString().slice(0, 10);
  // The form shows each text's version and date and links its words on S-06, so the words stay on the server.
  const texts = ACCEPTED_KINDS.map((k) => ({ ...currentLegalText(k), text: '' }));

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>{INVITATION_PAGE_COPY.heading(invitation.org.name)}</h1>
        <p>{INVITATION_PAGE_COPY.invitedLine(invitation.invitedBy.name, roleWithArticle(invitation.role), formatDay(expiresOn))}</p>
        <AcceptInvitationClient
          token={token}
          invitedEmail={invitation.email}
          orgName={invitation.org.name}
          role={invitation.role}
          inviterName={invitation.invitedBy.name}
          viewerEmail={identity?.email ?? null}
          viewerUserId={identity?.userId ?? null}
          expiresOn={expiresOn}
          texts={texts}
        />
      </div>
    </div>
  );
}
