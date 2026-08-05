import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { identityDb } from '@/lib/data/identity';
import { bootstrapOrgWithOwner } from '@/lib/data/preauth';
import { validateEmail, validatePassword, validateString, collectErrors } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

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
  try {
    const body = await request.json();
    const { password, termsAccepted, researchConsent } = body;

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
      researchConsent: researchConsent || false,
      ipAddress: ip,
    });

    logSecurityEvent('AUTH_REGISTER', 'info', {
      userId: result.userId,
      details: { email, orgId: result.orgId },
    });

    return NextResponse.json({ success: true, userId: result.userId }, { status: 201 });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
