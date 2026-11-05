import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi, UnauthenticatedError } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { logSecurityEvent } from '@/lib/security-logger';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { publicOrigin } from '@/lib/publicOrigin';
import { AppError } from '@/lib/http/errors';
import { adminSetAccountActive } from '@/lib/data/definer';
import { MAX_REQUEST_REFERENCE, accountHasMembership } from '@/lib/data/admin';
import { isRequestId } from '@/lib/data/idempotency';

/**
 * An absolute URL on the public site, for a redirect. NOT `new URL(path, request.url)`:
 * the standalone server builds `request.url` from the address it binds to ($HOSTNAME,
 * D-236), so behind nginx its host is the container id, or `0.0.0.0` since the runner
 * image sets `ENV HOSTNAME=0.0.0.0`. A `Location` on either goes nowhere for a browser.
 * The origin comes from configuration, as it does for invitation links
 * (lib/publicOrigin.ts). `__tests__/unit/redirect-origin.test.ts` holds this route, and
 * every other server file, to it.
 */
function publicUrl(path: string): URL {
  return new URL(path, publicOrigin());
}

/** The longest request reference S-25 accepts (as routes 41 to 46, units/ORG.md Task 7). */

/** A text field of the form, or null when it is absent or not text. */
function field(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === 'string' ? v : null;
}

/**
 * Route 47, the MAK-AI administrator's account actions on S-25 (`/admin/accounts`): deactivate or
 * reactivate an account, and the platform role. Driven by the HTML forms on S-25, so it reads form data
 * (AdminUserForm) and answers with a 303 back to S-25, never JSON for an expected case.
 *
 *  - `active=false|true` with the form's `requestId` sets the account to the state its button names, through
 *    `adminSetAccountActive` (lib/data/definer.ts), the
 *    definer function that raises `sessionEpoch` on deactivation (every session ends, ADR-0002), voids
 *    reset tokens and writes one organisation_events row per organisation of the account, or one
 *    platform_events row (FR-ORG-07, FR-ORG-09). Deactivating the only active owner of an organisation
 *    needs the reference of the controller's written request.
 *  - `role=admin` is always refused (NFR-SEC-19, SRS line 3003): the only caller is the one administrator,
 *    so a grant would make a second. A member is refused naming the membership (NFR-SEC-04 (d)).
 *  - `role=assessor` sets the platform role as before.
 *
 * An account already in the state asked for is left alone (a double submit is a no-op, never a toggle back).
 * Refusals redirect to `/admin/accounts?error=<code>` and write nothing. The caller's own account is
 * refused first (`error=self`), as is the definer's `self_deactivation`.
 *
 * `User.role` here is the PLATFORM role (admin/assessor), a non-tenant axis separate from `OrgRole`,
 * gated by `identity.platformRole`, not `requireOrgContext`/`Action`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Resolved first, before any database access. publicOrigin() throws when NEXTAUTH_URL is
  // unset; asking now means that fails the request before a role change or deactivation is
  // written, not after it has committed and only the redirect is left to build.
  const accountsUrl = publicUrl('/admin/accounts');
  const refused = (query: string) => NextResponse.redirect(publicUrl(`/admin/accounts?${query}`), 303);

  let identity;
  try {
    // CSRF defence (NFR-SEC-08), before the identity read: lib/http/sameOrigin.ts refuses another site's
    // Origin, `Origin: null` and an unparseable one with 403 cross_origin, which toResponse below answers.
    assertSameOrigin(request);
    identity = await requireIdentityForApi();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.redirect(publicUrl('/login'), 303);
    }
    // Anything else — including a flagged `mustChangePassword` admin, who
    // gets `toResponse`'s 403 `{ code: 'must_change_password' }` — is not
    // this route's own case to special-case; delegate to the shared
    // mapping (lib/http/toResponse.ts) and let it rethrow what it doesn't
    // recognise.
    return toResponse(e);
  }
  if (identity.platformRole !== 'admin') {
    return NextResponse.redirect(publicUrl('/'), 303);
  }

  // Everything after the identity check runs inside one try, so an unreachable database or a malformed
  // body reaches toResponse (a support reference, NFR-OBS-05) instead of Next's bare 500.
  try {
    const { id } = await params;
    const form = await request.formData();
    const active = field(form, 'active');
    const role = field(form, 'role');
    // A state change names the state its button shows (`active=false` for Deactivate, `true` for Reactivate) and
    // the request id of the page's form; a form that names neither, or names the old `action` toggle, is refused.
    const changesState = active !== null || form.has('action');
    if (changesState && ((active !== 'true' && active !== 'false') || !isRequestId(field(form, 'requestId')))) {
      return NextResponse.json({ error: 'Name the state, true or false, and the request id' }, { status: 400 });
    }

    const target = await identityDb.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });
    if (!target) return NextResponse.redirect(accountsUrl, 303);

    // An administrator may not change their own role or deactivate themselves: that would lock the
    // platform out of its only administrator.
    if (target.id === identity.userId) return refused('error=self');

    if (changesState) {
      const nextActive = active === 'true';
      const requestId = field(form, 'requestId');
      // The account already has the state asked for: a repeat of the same click, or a stale page. Nothing is
      // written, so a second Deactivate can never turn into a reactivation.
      if (target.isActive === nextActive) {
        logSecurityEvent('ADMIN_ACTION', 'info', {
          userId: identity.userId,
          details: { action: 'account_state_unchanged', targetUserId: id, requestId },
        });
        return NextResponse.redirect(accountsUrl, 303);
      }
      // S-25 limits the field to the same length (maxLength); a longer one is refused, never cut.
      const reference = field(form, 'requestReference')?.trim() ?? '';
      if (reference.length > MAX_REQUEST_REFERENCE) {
        return NextResponse.json({ error: `A request reference is at most ${MAX_REQUEST_REFERENCE} characters` }, { status: 400 });
      }
      let affectedOrgIds: string[];
      try {
        ({ affectedOrgIds } = await adminSetAccountActive({
          actorUserId: identity.userId, userId: id, active: nextActive, requestReference: reference === '' ? null : reference,
        }));
      } catch (e) {
        // The two refusals S-25 explains; every other error (not_found for an account removed meanwhile,
        // an unreachable database) goes to toResponse below unchanged.
        if (e instanceof AppError && e.code === 'self_deactivation') return refused('error=self');
        if (e instanceof AppError && e.code === 'request_reference_required') return refused(`error=request_reference_required&user=${encodeURIComponent(id)}`);
        throw e;
      }
      logSecurityEvent('ADMIN_ACTION', 'warn', {
        userId: identity.userId,
        details: { action: nextActive ? 'reactivate' : 'deactivate', targetUserId: id, requestId, organisations: affectedOrgIds.length },
      });
    } else if (role === 'admin') {
      // NFR-SEC-19: never a second administrator. The users_platform_admin_single trigger refuses one in the
      // database as well, so no other writer can make one either. The refusal is logged: an attempt to grant
      // the platform role is the event worth seeing after a stolen administrator session.
      const code = (await accountHasMembership(id)) ? 'has_membership' : 'single_admin';
      logSecurityEvent('ADMIN_ACTION', 'warn', {
        userId: identity.userId,
        details: { action: 'role_grant_refused', targetUserId: id, reason: code },
      });
      return refused(`error=${code}`);
    } else if (role === 'assessor') {
      if (target.role !== 'assessor') {
        await identityDb.user.update({ where: { id }, data: { role } });
        logSecurityEvent('ADMIN_ACTION', 'warn', {
          userId: identity.userId,
          details: { action: 'role_change', targetUserId: id, newRole: role },
        });
      }
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (e) {
    return toResponse(e);
  }

  return NextResponse.redirect(accountsUrl, 303);
}
