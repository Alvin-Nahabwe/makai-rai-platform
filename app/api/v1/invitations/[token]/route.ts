import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { offeredAcceptances } from '@/lib/data/acceptances';
import { acceptInvitationViaDefiner } from '@/lib/data/definer';
import { hashInvitationToken } from '@/lib/data/invitationToken';
import { invitationByToken } from '@/lib/data/preauth';
import { AcceptancesRequiredError, AppError } from '@/lib/http/errors';
import { invitationUnusable as unusable } from '@/lib/http/messages';
import { INVITATION_ROUTE_COPY } from '@/lib/http/api/copy';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 32 (FR-ACC-01): the signed-in account accepts an invitation for its own
 * email, and answers 200 `{ orgSlug }`. POST only: S-04 reads the invitation server-side
 * (`app/(public)/invitations/[token]/page.tsx`).
 *
 * Order: the origin check; the identity gate with the acceptance gate (an account without the
 * three acceptances gets 403 `acceptances_required` with `missing`, which S-04 turns into the
 * acceptance form); the invitation by token (410 M-23 when unusable); the account's email,
 * read fresh from the database by the gate, compared with the invitation's without regard to
 * case, before the definer is called, so a wrong-account attempt (409 `wrong_account`) never
 * touches the token and the invitee can still accept; a current version only offered (not yet
 * accepted) is a 403 `acceptances_required` naming those kinds (FR-ACC-03); then `accept_invitation` through K0a's
 * wrapper, which makes the membership with the invitation's role and refuses a used, expired or
 * revoked token and a platform administrator, each as the same 410 M-23. No E-06: no account is
 * created here.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    const { token } = await ctx.params;
    const invitation = await invitationByToken(token);
    if (invitation === null) throw unusable();
    if (invitation.email.toLowerCase() !== identity.email.toLowerCase()) {
      throw new AppError(409, 'wrong_account', INVITATION_ROUTE_COPY.wrongAccount);
    }
    // FR-ACC-03: a membership from an invitation waits for the current version of each text, even one
    // that is only offered (it would not block the gate): 403 with those kinds, which S-04 turns into the form.
    const offered = await offeredAcceptances(identity.userId);
    if (offered.length > 0) throw new AcceptancesRequiredError(offered.map((t) => t.kind));
    try {
      await acceptInvitationViaDefiner({ tokenHash: hashInvitationToken(token), userId: identity.userId });
    } catch (e) {
      if (e instanceof AppError && e.code === 'invitation_unusable') throw unusable();
      throw e;
    }
    // The slug was read with the invitation, before the write: no read after the commit can turn a membership into a 5xx.
    return NextResponse.json({ orgSlug: invitation.org.slug });
  } catch (e) {
    return toResponse(e);
  }
}
