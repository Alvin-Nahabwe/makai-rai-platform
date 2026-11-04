import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { ValidationFailed } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import type { PreferencesRequest } from '@/types/api';

/**
 * Contract route row 37 (FR-FUP-06): PATCH `{ reminderEmails: boolean }` sets the signed-in
 * account's own setting and answers 204. It writes `reminderEmails` of `identity.userId` and
 * nothing else; any other key, or a value that is not a boolean, answers 422 `validation` and
 * writes nothing. A person who has not yet accepted the current texts may still turn reminders
 * off (S-21 is reachable then), so `allowMissingAcceptances: true`; it still needs a session.
 */
export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi({ allowMissingAcceptances: true });
    const body: unknown = await req.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) return null;   // not JSON: refused below as a missing `reminderEmails`
      throw e;
    });
    const { reminderEmails } = preferencesOf(body);
    await identityDb.user.update({ where: { id: identity.userId }, data: { reminderEmails } });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return toResponse(e);
  }
}

function preferencesOf(body: unknown): PreferencesRequest {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const unknownKey = Object.keys(record).find((k) => k !== 'reminderEmails');
  if (unknownKey !== undefined) {
    throw new ValidationFailed([{ field: unknownKey, message: 'Only reminderEmails can be changed here.' }]);
  }
  if (typeof record.reminderEmails !== 'boolean') {
    throw new ValidationFailed([{ field: 'reminderEmails', message: 'Choose on or off.' }]);
  }
  return { reminderEmails: record.reminderEmails };
}
