import { NextRequest, NextResponse } from 'next/server';
import { requireIdentityForApi, UnauthenticatedError } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Admin action endpoint for user management (promote / demote / deactivate /
 * reactivate). Driven by the HTML forms on /admin/users, so it accepts
 * form-encoded data and redirects back to the table — a 401 JSON body
 * would be wrong here the same way it would for a `fetch()` caller
 * expecting one (lib/auth/identity.ts's page/API split), just inverted:
 * this route's caller is a browser form submission, so it gets a redirect,
 * not JSON.
 *
 * `User.role` here is the PLATFORM role (admin/assessor), a non-tenant,
 * non-org-scoped axis entirely separate from `OrgRole` — gated by
 * `identity.platformRole`, not `requireOrgContext`/`Action`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const usersUrl = new URL('/admin/users', request.url);

  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL('/login', request.url), 303);
    }
    throw e;
  }
  if (identity.platformRole !== 'admin') {
    return NextResponse.redirect(new URL('/', request.url), 303);
  }

  // CSRF defense: this is a state-changing form POST, so reject cross-origin
  // submissions. Browsers always send Origin on POST.
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && new URL(origin).host !== host) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }

  const { id } = await params;
  const form = await request.formData();
  const action = form.get('action');
  const role = form.get('role');

  const target = await identityDb.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) return NextResponse.redirect(usersUrl, 303);

  // An admin may not demote or deactivate themselves — prevents locking the
  // platform out of its last admin by accident.
  if (target.id === identity.userId) {
    return NextResponse.redirect(new URL('/admin/users?error=self', request.url), 303);
  }

  if (action === 'deactivate') {
    const nextActive = !target.isActive;
    await identityDb.user.update({ where: { id }, data: { isActive: nextActive } });
    logSecurityEvent('ADMIN_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: nextActive ? 'reactivate' : 'deactivate', targetUserId: id },
    });
  } else if (role === 'admin' || role === 'assessor') {
    await identityDb.user.update({ where: { id }, data: { role } });
    logSecurityEvent('ADMIN_ACTION', 'warn', {
      userId: identity.userId,
      details: { action: 'role_change', targetUserId: id, newRole: role },
    });
  } else {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  return NextResponse.redirect(usersUrl, 303);
}
