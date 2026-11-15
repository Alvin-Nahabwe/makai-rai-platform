import type { Metadata } from 'next';
import { invitationByToken } from '@/lib/data/preauth';
import { tryResolveIdentity } from '@/lib/auth/identity';
import { missingAcceptances } from '@/lib/data/acceptances';
import { INVITATION_COPY } from '@/lib/invitations/copy';
import { currentLegalText } from '@/lib/legal/registry';
import { ACCEPTED_KINDS } from '@/types/legal';
import { formatDay } from '@/lib/format/dates';
import { INVITATION_PAGE_COPY, ORG_COPY, roleTerm, roleWithArticle } from '@/lib/org/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';
import { GatePublicFrame } from '@/components/layout/GatePublicFrame';
import type { GateStop } from '@/components/layout/GateRoute';
import { AuthCard } from '@/components/auth/AuthCardBase';
import AcceptInvitationClient, { InvitationRoute } from './AcceptInvitationClient';

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
 *
 * In the gate frame's public variant since plan 1B Task 6 (rulings L5-14, L5-15): the card says who invited the person, as
 * what, what that role means (the vocabulary's sentence, plain text) and until when; the frame's route is this door's
 * steps. Signed out: Your details, Accept the terms, Join, drawn in the browser from the new-account form's step
 * (InvitationRoute in the frame's routeSlot, ruling L5-28). The frame is GatePublicFrame and the card AuthCardBase, so the
 * first visit carries neither the signed-in frame's sheet and code nor components/auth/auth.css (the lean frame, owner,
 * 15 Nov 15:35). Signed in as the invited email: Join alone when it is the one
 * step left, or Accept the terms then Join while one of the person's own acceptances is missing (route 32 asks for it
 * first). Signed in as someone else (M-24) and an unusable link: none.
 */
const JOIN_ROUTE: readonly GateStop[] = [{ label: INVITATION_COPY.stops.join, state: 'current' }];
const ACCEPT_THEN_JOIN_ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.accept, state: 'current' },
  { label: INVITATION_COPY.stops.join, state: 'upcoming' },
];
export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitation = await invitationByToken(token);

  if (!invitation) {
    return (
      <GatePublicFrame>
        <AuthCard title={INVITATION_PAGE_COPY.unusableHeading}>
          <p>{INVITATION_PAGE_COPY.unusable}</p>
        </AuthCard>
      </GatePublicFrame>
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

  const invitee = identity !== null && identity.email.toLowerCase() === invitation.email.toLowerCase() ? identity : null;
  const route = invitee === null ? undefined : (await missingAcceptances(invitee.userId)).length > 0 ? ACCEPT_THEN_JOIN_ROUTE : JOIN_ROUTE;

  return (
    <GatePublicFrame route={route} routeSlot={identity === null ? <InvitationRoute /> : undefined}>
      <AuthCard
        title={INVITATION_PAGE_COPY.heading(invitation.org.name)}
        lead={(
          <>
            <p>{INVITATION_PAGE_COPY.invitedBy(invitation.invitedBy.name, roleWithArticle(invitation.role))}</p>
            <p>{roleTerm(invitation.role).definition}</p>
            <p>{INVITATION_PAGE_COPY.endsOn(formatDay(expiresOn))}</p>
          </>
        )}
      >
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
      </AuthCard>
    </GatePublicFrame>
  );
}
