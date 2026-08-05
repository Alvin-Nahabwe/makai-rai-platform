import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';

/**
 * The one place every org-scoped route handler's catch block delegates to.
 * Maps the error types `requireOrgContext`/`requireIdentityForApi` can
 * throw to their HTTP status — and nothing else: an error that is none of
 * these is NOT this function's to interpret. Rethrowing lets it surface as
 * a loud 500 (Next.js's own unhandled-error path) instead of being
 * laundered into a misleading 4xx (AGENTS.md §2: investigate a failure,
 * don't paper over it with a broad catch).
 *
 * `NotFoundError` carries no detail by construction (lib/data/tenant.ts) —
 * "unknown slug" and "not a member" are indistinguishable here on purpose
 * (ADR-0001: never leak org existence to a non-member).
 *
 * `PasswordChangeRequiredError` is the single mapping every caller of
 * `requireIdentityForApi()` shares for the must-change-password gate (see
 * that function's comment in lib/auth/identity.ts) — centralised here so
 * every route that reaches it (directly, or transitively through
 * `requireOrgContext`) reports the SAME 403 shape, `code` included, rather
 * than each route re-deciding its own wording.
 */
export function toResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (e instanceof PasswordChangeRequiredError) {
    return NextResponse.json(
      { error: 'Password change required', code: 'must_change_password' },
      { status: 403 },
    );
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  throw e;
}
