import { NextRequest, after } from 'next/server';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { ValidationFailed } from '@/lib/http/errors';
import { completePasswordReset, sendPasswordChangedNotice } from '@/lib/data/passwordReset';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Contract route row 34: set a new password from a reset link (FR-ACC-06, S-03). Public. The token arrives in the body,
 * never in the path or query, so it reaches no request log (NFR-OBS-01, B9). 204 on success, ending every earlier
 * session of the account (its `sessionEpoch` rises); 410 `reset_link_unusable` with M-22 for a used, expired, voided or
 * unknown token; 422 for a new password under 12 characters, which consumes nothing. E-02 goes after the answer
 * (FR-ACC-09).
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    assertSameOrigin(req);
    const { token, newPassword } = await bodyOf(req);
    const changedAt = new Date();
    const { userId } = await completePasswordReset(token, newPassword, changedAt);
    logSecurityEvent('PASSWORD_RESET_COMPLETED', 'info', { userId, details: { sessionsRevoked: true } });
    after(async () => {
      const failure = await sendPasswordChangedNotice(userId, changedAt).catch(() => 'notice_failed' as const);
      if (failure) logSecurityEvent('PASSWORD_RESET_COMPLETED', 'error', { userId, details: { noticeSent: false, reason: failure } });
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}

/** `{ token, newPassword }`; a body that is not JSON is a 422, and a missing token is an unusable link (410). */
async function bodyOf(req: NextRequest): Promise<{ token: string; newPassword: string }> {
  const body: unknown = await req.json().catch((e: unknown) => {
    if (e instanceof SyntaxError) throw new ValidationFailed([{ field: 'body', message: 'The request body is not JSON.' }]);
    throw e;
  });
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  // A missing or non-string password is refused by validatePassword as 'Password is required' (422).
  return { token: typeof b.token === 'string' ? b.token : '', newPassword: typeof b.newPassword === 'string' ? b.newPassword : '' };
}
