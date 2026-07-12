import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/authz';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Admin action endpoint for user management (promote / demote / deactivate /
 * reactivate). Driven by the HTML forms on /admin/users, so it accepts
 * form-encoded data and redirects back to the table.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const usersUrl = new URL('/admin/users', request.url);

  const actor = await getSessionUser();
  if (!actor) return NextResponse.redirect(new URL('/login', request.url), 303);
  if (actor.role !== 'admin') return NextResponse.redirect(new URL('/dashboard', request.url), 303);

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

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) return NextResponse.redirect(usersUrl, 303);

  // An admin may not demote or deactivate themselves — prevents locking the
  // platform out of its last admin by accident.
  if (target.id === actor.id) {
    return NextResponse.redirect(new URL('/admin/users?error=self', request.url), 303);
  }

  if (action === 'deactivate') {
    const nextActive = !target.isActive;
    await prisma.user.update({ where: { id }, data: { isActive: nextActive } });
    logSecurityEvent('ADMIN_ACTION', 'warn', {
      userId: actor.id,
      details: { action: nextActive ? 'reactivate' : 'deactivate', targetUserId: id },
    });
  } else if (role === 'admin' || role === 'assessor') {
    await prisma.user.update({ where: { id }, data: { role } });
    logSecurityEvent('ADMIN_ACTION', 'warn', {
      userId: actor.id,
      details: { action: 'role_change', targetUserId: id, newRole: role },
    });
  } else {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  return NextResponse.redirect(usersUrl, 303);
}
