import { NextRequest } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { AppError, NotImplementedError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 41: POST to create an organisation. A gated stub until ORG merges (PENDING_ROUTES
 * in lib/authz/routeActions.ts): it refuses a cross-origin request, then a caller with no session
 * (401) or without the platform role `admin` (403), and only then answers 501.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const identity = await requireIdentityForApi();
    if (identity.platformRole !== 'admin') throw new AppError(403, 'forbidden', 'Forbidden');
    throw new NotImplementedError('ORG');
  } catch (e) {
    return toResponse(e);
  }
}
