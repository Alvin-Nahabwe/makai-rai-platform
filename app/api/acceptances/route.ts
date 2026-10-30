import { NextRequest } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { NotImplementedError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 30: POST to record the legal texts a person accepts. A gated stub until ACC-a
 * merges (PENDING_ROUTES in lib/authz/routeActions.ts): it refuses a cross-origin request, then a
 * caller with no session (401), and only then answers 501. ACC-a adds `allowMissingAcceptances: true`
 * to the identity gate (FR-ACC-04).
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await requireIdentityForApi({ allowMissingAcceptances: true });
    throw new NotImplementedError('ACC-a');
  } catch (e) {
    return toResponse(e);
  }
}
