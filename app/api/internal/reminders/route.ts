import { NextRequest } from 'next/server';
import { UnauthenticatedError } from '@/lib/auth/identity';
import { NotImplementedError } from '@/lib/http/errors';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 40: POST to run the follow-up reminder job. A gated stub until OPS merges
 * (PENDING_ROUTES in lib/authz/routeActions.ts): it refuses a cross-origin request, then a request
 * with no `Authorization` header (401), and only then answers 501.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    // Presence only, and no setting is read: OPS adds the full check (FR-OPS-02: a 64-hex bearer token
    // compared in constant time against REMINDER_JOB_TOKEN). An empty header counts as absent.
    if (!req.headers.get('authorization')) throw new UnauthenticatedError('reminder token missing');
    throw new NotImplementedError('OPS');
  } catch (e) {
    return toResponse(e);
  }
}
