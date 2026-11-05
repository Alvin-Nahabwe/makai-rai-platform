import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { UnauthenticatedError } from '@/lib/auth/identity';
import { toResponse } from '@/lib/http/toResponse';
import { runReminders } from '@/lib/reminders/job';

/**
 * Contract route 40 (FR-OPS-02, NFR-SEC-13): POST runs the follow-up reminder job, for the host's hourly
 * wrapper calling from inside the web container. No session. nginx refuses the whole /api/internal/ prefix
 * from outside (docker/nginx/default.conf); this check is the second lock.
 *
 * The caller sends `Authorization: Bearer <token>`, and the token is the web container's own
 * REMINDER_JOB_TOKEN. Both must be exactly 64 lowercase hex characters (what `openssl rand -hex 32` prints):
 * a setting that is unset, empty or malformed refuses every call, so an empty header never equals an empty
 * setting. The two are compared as SHA-256 digests with `timingSafeEqual`: digests are always 32 bytes, so a
 * token of another length is a 401 and not the RangeError `timingSafeEqual` throws for unequal lengths.
 * Every refusal is the same 401. The token and the header are never logged (NFR-SEC-14), and toResponse
 * logs nothing for a 4xx. No Origin check: the caller is not a browser, and AUTHZ lists this route as exempt.
 */

const TOKEN_FORM = /^[0-9a-f]{64}$/;
const HEADER_FORM = /^Bearer ([0-9a-f]{64})$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function assertReminderToken(req: Request): void {
  const configured = process.env.REMINDER_JOB_TOKEN;
  const presented = HEADER_FORM.exec(req.headers.get('authorization') ?? '')?.[1];
  if (configured === undefined || !TOKEN_FORM.test(configured) || presented === undefined) {
    throw new UnauthenticatedError('reminder token refused');
  }
  if (!timingSafeEqual(sha256(presented), sha256(configured))) throw new UnauthenticatedError('reminder token refused');
}

export async function POST(req: NextRequest) {
  try {
    assertReminderToken(req);
    const { attempted, sent, failed, optedOut, skippedLocked } = await runReminders(new Date());
    return NextResponse.json({ attempted, sent, failed, optedOut, skippedLocked });
  } catch (e) {
    return toResponse(e);
  }
}
