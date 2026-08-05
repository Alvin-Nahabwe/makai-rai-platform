import { NextResponse } from 'next/server';
import { requireIdentityForApi, bumpSessionEpoch } from '@/lib/auth/identity';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * "Log out everywhere" — ADR-0002 §4's fourth revocation trigger (the other
 * three are password change, administrative deactivation, and any future
 * admin action that should end outstanding sessions). Ends every session
 * for the CALLING user, including the one making this request — the client
 * is expected to also clear its own cookie via `signOut()` immediately
 * after (mirrors `app/(authenticated)/change-password/page.tsx`'s own
 * pattern), since bumping the epoch does not retroactively un-issue an
 * already-delivered cookie, only make it fail the next `resolveIdentity`
 * check.
 *
 * `bumpSessionEpoch` (lib/auth/identity.ts) is the ONE place this
 * increments the counter from — no separate raw update here, so there is
 * exactly one code path to audit for "does this actually invalidate
 * sessions".
 *
 * Gated by `requireIdentityForApi()` with its DEFAULT options (no
 * `allowMustChangePassword`): a caller mid-forced-password-change is not
 * blocked from anything harmful by logging out everywhere, but there is
 * also no reason to special-case it — `signOut()` client-side already works
 * for ending the CURRENT browser's session regardless of this route.
 */
export async function DELETE() {
  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    return toResponse(e);
  }

  await bumpSessionEpoch(identity.userId);

  logSecurityEvent('AUTH_LOGOUT_EVERYWHERE', 'info', {
    userId: identity.userId,
    details: { result: 'success' },
  });

  return NextResponse.json({ success: true });
}
