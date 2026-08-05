import { NextRequest, NextResponse } from 'next/server';
import { acceptInvitation, InvitationError } from '@/lib/data/preauth';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { toResponse } from '@/lib/http/toResponse';

/**
 * POST-only. There is no `GET` here: the public preview (org name, invited
 * email, role) is read server-side by `app/(public)/invitations/[token]/page.tsx`
 * calling `invitationByToken` directly — a standalone unauthenticated JSON
 * preview endpoint would have had no caller and no test coverage (a
 * `simplify` pass on Task 8 found exactly this). Mirrors D-117's precedent:
 * unused surface is deferred rather than shipped untested — see
 * `docs/DEFERRED_REGISTER.md` D-121 if a future consumer (e.g. Task 9's
 * email template) needs a standalone preview API.
 *
 * Accepts the invitation for the CALLING, already-authenticated user.
 * Requires a real session (`requireIdentityForApi`) — this route never
 * authenticates anyone as a side effect (Task 8 brief / D-098's decision 9):
 * the caller must already have logged in (existing account) or registered
 * and then logged in (new account, via `POST .../register`) before reaching
 * here.
 *
 * `identity.email` is read fresh from the database by
 * `requireIdentityForApi` -> `resolveIdentity` on every call, never taken
 * from the request body or the JWT claim alone — that is what makes the
 * email-binding check inside `acceptInvitation` authoritative rather than
 * client-assertable.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const identity = await requireIdentityForApi();
    const result = await acceptInvitation({
      rawToken: token,
      userId: identity.userId,
      userEmail: identity.email,
    });
    return NextResponse.json({ orgId: result.orgId, role: result.role });
  } catch (e) {
    if (e instanceof InvitationError) {
      return NextResponse.json({ error: e.message }, { status: 410 });
    }
    // `toResponse` maps `UnauthenticatedError` -> 401 and rethrows anything
    // else uncaught (lib/http/toResponse.ts) — reused rather than
    // hand-rolling the same 401 branch a second time in this file.
    return toResponse(e);
  }
}
