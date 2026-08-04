import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError } from '@/lib/auth/identity';

/**
 * The one place every org-scoped route handler's catch block delegates to.
 * Maps the three error types `requireOrgContext`/`requireIdentityForApi` can
 * throw to their HTTP status — and nothing else: an error that is none of
 * these three is NOT this function's to interpret. Rethrowing lets it
 * surface as a loud 500 (Next.js's own unhandled-error path) instead of
 * being laundered into a misleading 4xx (AGENTS.md §2: investigate a
 * failure, don't paper over it with a broad catch).
 *
 * `NotFoundError` carries no detail by construction (lib/data/tenant.ts) —
 * "unknown slug" and "not a member" are indistinguishable here on purpose
 * (ADR-0001: never leak org existence to a non-member).
 */
export function toResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  throw e;
}
