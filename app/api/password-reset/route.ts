import { NextRequest, NextResponse, after } from 'next/server';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { requestPasswordReset } from '@/lib/data/passwordReset';
import { logSecurityEvent } from '@/lib/security-logger';
import { M21 } from '@/lib/http/messages';


/**
 * Contract route row 33: ask for a password reset link (FR-ACC-06, S-02). Public: a person who cannot sign in. It refuses
 * a cross-origin request (NFR-SEC-08), then answers 202 with M-21 at once for every body, a malformed one included, and
 * does all the work in `after()`, so neither the body nor the time tells whether the address has an account (B7). The
 * limits (3 an account an hour, 200 a platform hour) answer the same 202 (contract, rate-limit row for this route).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (e) {
    return toResponse(e);
  }
  const email = await emailOf(req);
  if (email !== null) {
    after(async () => {
      try {
        await requestPasswordReset(email, new Date());
      } catch (e) {
        // After the answer nothing can report this to the person. The log line names the error's class and code, both
        // fixed identifiers, and never its message, which can name the database host or an address.
        const errorName = e instanceof Error ? e.name : typeof e;
        const code = typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : undefined;
        logSecurityEvent('PASSWORD_RESET_REQUESTED', 'error', { details: { sent: false, reason: 'request_failed', errorName, ...(code ? { code } : {}) } });
      }
    });
  }
  return NextResponse.json({ message: M21 }, { status: 202 });
}

/** The `email` of a JSON body `{ email: string }`, or null for any other body: the answer is the same either way. */
async function emailOf(req: NextRequest): Promise<string | null> {
  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return null;
  const email = (body as Record<string, unknown>).email;
  return typeof email === 'string' && email.length > 0 && email.length <= 320 ? email : null;
}
