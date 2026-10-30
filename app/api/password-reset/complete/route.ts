import { NextRequest } from 'next/server';
import { NotImplementedError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 34: POST to set a new password with a reset link. A gated stub until ACC-b merges
 * (PENDING_ROUTES in lib/authz/routeActions.ts): it refuses a cross-origin request, then nothing: the
 * route is public, so only the cross-origin check applies, and only then answers 501.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    throw new NotImplementedError('ACC-b');
  } catch (e) {
    return toResponse(e);
  }
}
