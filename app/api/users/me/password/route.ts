import { NextRequest, NextResponse, after } from 'next/server';
import { compare, hash } from 'bcryptjs';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { sendPasswordChangedNotice, voidResetTokens } from '@/lib/data/passwordReset';
import { validatePassword } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';
import { ValidationFailed } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 35: change the password (FR-ACC-08; S-21 and S-29). On success every session of the account ends,
 * this one included (its `sessionEpoch` rises), earlier reset links are voided (FR-ACC-06), the lock is cleared, and E-02
 * goes after the answer (FR-ACC-09).
 *
 * The whole handler sits in one `try` whose `catch` is `toResponse`, so an unreachable database answers 503
 * `database_unavailable` with a support reference and one REQUEST_FAILED line, and `UnauthenticatedError` answers 401
 * (NFR-AVL-04, NFR-OBS-05). The route's own answers are unchanged: 400 for a missing current password, a wrong one or an
 * unchanged one; 422 for a new password under 12 or over 128 characters.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    // `allowMustChangePassword: true`: this IS the action that clears the flag. Every other caller of
    // `requireIdentityForApi` must leave it unset (lib/auth/identity.ts), or a flagged account could never reach the one
    // route that fixes it. `allowMissingAcceptances: true`: S-21's, usable before the acceptances (FR-ACC-04).
    const identity = await requireIdentityForApi({ allowMustChangePassword: true, allowMissingAcceptances: true });

    // A body that is not JSON is a 422: handed to toResponse it would be a logged 500, and V8's JSON error message
    // quotes the start of the body, which can be the password.
    const body: unknown = await request.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) throw new ValidationFailed([{ field: 'body', message: 'The request body is not JSON.' }]);
      throw e;
    });
    const { currentPassword, newPassword } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
    }
    // NFR-SEC-18: a new password under 12 or over 128 characters is a 422 naming the field.
    const pwError = validatePassword(newPassword);
    if (pwError) throw new ValidationFailed([{ field: 'newPassword', message: pwError.message }]);

    const dbUser = await identityDb.user.findUnique({
      where: { id: identity.userId },
      select: { passwordHash: true },
    });
    if (!dbUser) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const currentValid = await compare(currentPassword, dbUser.passwordHash);
    if (!currentValid) {
      logSecurityEvent('AUTH_PASSWORD_CHANGED', 'warn', {
        userId: identity.userId,
        details: { result: 'rejected_wrong_current_password' },
      });
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
    }

    const sameAsOld = await compare(newPassword as string, dbUser.passwordHash);
    if (sameAsOld) {
      return NextResponse.json(
        { error: 'New password must be different from the current one' },
        { status: 400 },
      );
    }

    const passwordHash = await hash(newPassword as string, 12);
    const changedAt = new Date();
    // ONE statement: `passwordHash` and the `sessionEpoch` bump land in the same atomic UPDATE, so a partial success can
    // never leave a new password active while an attacker's already-copied cookie (matching the OLD epoch) still passes
    // `resolveIdentity` (ADR-0002 §4's password-change revocation trigger). The epoch helper the sign-out-everywhere route
    // uses (lib/auth/identity.ts) is deliberately not reused: it issues its own, separate UPDATE. The lock is cleared in
    // the same statement.
    // Earlier reset links go first: if that fails, nothing has changed; the password update is the last write.
    await voidResetTokens(identity.userId, changedAt);
    await identityDb.user.update({
      where: { id: identity.userId },
      data: { passwordHash, mustChangePassword: false, sessionEpoch: { increment: 1 }, failedLoginAttempts: 0, lockedUntil: null },
    });

    logSecurityEvent('AUTH_PASSWORD_CHANGED', 'info', {
      userId: identity.userId,
      details: { result: 'success', sessionsRevoked: true },
    });
    const userId = identity.userId;
    after(async () => {
      const failure = await sendPasswordChangedNotice(userId, changedAt).catch(() => 'notice_failed' as const);
      if (failure) logSecurityEvent('AUTH_PASSWORD_CHANGED', 'error', { userId, details: { noticeSent: false, reason: failure } });
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return toResponse(e);
  }
}
