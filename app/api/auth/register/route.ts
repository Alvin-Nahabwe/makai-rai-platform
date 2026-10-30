import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { identityDb } from '@/lib/data/identity';
import { bootstrapOrgWithOwner } from '@/lib/data/preauth';
import { openRegistrationEnabled } from '@/lib/auth/openRegistration';
import { validateEmail, validatePassword, validateString, collectErrors } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Registration now creates a whole tenant, not just a `User`: `projects.orgId`
 * is NOT NULL, and a user with no organization and no membership cannot reach
 * any tenant data. `bootstrapOrgWithOwner` (`lib/data/preauth.ts`) creates the
 * User, Organization, owner Membership and consent rows in one transaction on
 * the owner (BYPASSRLS) connection — `withOrg` structurally cannot do this,
 * because a brand-new organization is not yet "the current one" its RLS
 * policy checks against (D-078).
 */
export async function POST(request: NextRequest) {
  // FIRST, before parsing, validating or touching the database. PLAN.md:217
  // rules registration invite-gated until T3; until 2026-08-29 nothing here
  // implemented that, so any stranger could create a live tenant on the public
  // site. Invitations are unaffected -- they go through
  // app/api/v1/invitations/[token]/register/route.ts, which documents that it
  // is deliberately not this route.
  if (!openRegistrationEnabled()) {
    return NextResponse.json(
      {
        error: 'Registration is by invitation only.',
        code: 'registration_closed',
      },
      { status: 403 },
    );
  }

  try {
    // CSRF defence (NFR-SEC-08), before the body is read: another site's Origin, `Origin: null` and an unparseable
    // one are refused with 403 cross_origin (lib/http/sameOrigin.ts), which the catch answers through toResponse.
    assertSameOrigin(request);
    const body = await request.json();
    // An old client may still post the withdrawn research tick box (Task 15). It is
    // ignored, never rejected: nothing here reads it, and nothing stores it.
    const { password, termsAccepted } = body;

    // Validate and sanitize inputs
    const nameResult = validateString(body.name, 'name', 100);
    const orgNameResult = validateString(body.orgName, 'organization name', 100);
    const emailError = validateEmail(body.email);
    const passwordError = validatePassword(password);

    // `validateString` only rejects a literally-empty input; a whitespace-only
    // string ('   ') passes it and is then trimmed down to '' by its internal
    // sanitizeInput step, so `orgNameResult.error` is null but `.value` is
    // empty (`pr-review-toolkit:code-reviewer` verified this live:
    // `validateString('   ', ...)` returns `{ value: '', error: null }`).
    // Left unguarded, that becomes `Organization.name = ''`, and
    // `deriveSlug('')` falls through to the shared literal `'org'` base
    // (`createOrgInTx` below) — every whitespace-only submission would land
    // in the same slug namespace. Guarded here rather than in `validateString`
    // itself, which is shared by the `name` field and other unrelated
    // callers this task does not own.
    const orgNameEmptyError = orgNameResult.error === null && orgNameResult.value.length === 0
      ? { field: 'organization name', message: 'organization name is required' }
      : null;

    const errors = collectErrors([
      nameResult.error, orgNameResult.error, orgNameEmptyError, emailError, passwordError,
    ]);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
    }

    const name = nameResult.value;
    const orgName = orgNameResult.value;
    const email = (body.email as string).trim().toLowerCase();

    if (!termsAccepted) {
      return NextResponse.json({ error: 'Terms of Service must be accepted' }, { status: 400 });
    }

    const existing = await identityDb.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }

    const passwordHash = await hash(password, 12);
    const ip = request.headers.get('x-forwarded-for') || 'unknown';

    // The uniqueness check above is a convenience, not the guarantee — it is
    // a separate query and therefore race-prone (TOCTOU). The database's
    // UNIQUE constraint on `users.email` is the real guarantee, enforced
    // inside the same transaction as every other row this registration
    // writes. If that race is lost, `bootstrapOrgWithOwner` throws and this
    // propagates to the generic-500 handler below — the same outcome the
    // pre-existing code had for this same race window (it had no special
    // case for it either). A prior version of this route added a P2002-
    // specific 409 branch here; `pr-review-toolkit:silent-failure-hunter`
    // found its "unknown error shape" fallback defaulted to affirmatively
    // (and wrongly, on an unproven shape) telling the caller "email already
    // exists," and that the branch had no test coverage. Removed rather than
    // hardened: the race is rare enough that a generic 500 telling the user
    // to retry is an honest response, and it avoids adding an untested,
    // fail-open-shaped classifier for a marginal UX improvement.
    const result = await bootstrapOrgWithOwner({
      email, name, passwordHash, orgName,
      ipAddress: ip,
    });

    logSecurityEvent('AUTH_REGISTER', 'info', {
      userId: result.userId,
      details: { orgId: result.orgId },
    });

    return NextResponse.json({ success: true, userId: result.userId }, { status: 201 });
  } catch (error) {
    // Every error goes through toResponse (lib/http/toResponse.ts): an AppError (today assertSameOrigin's 403
    // cross_origin) answers as designed, and anything unmapped is printed and answers 500 internal_error with a
    // support reference (NFR-OBS-05), as every other route does.
    return toResponse(error);
  }
}
