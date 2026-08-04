import { NextRequest, NextResponse } from 'next/server';
import { compare, hash } from 'bcryptjs';
import { requireIdentityForApi, UnauthenticatedError } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';
import { validatePassword } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

export async function POST(request: NextRequest) {
  let identity;
  try {
    identity = await requireIdentityForApi();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const body = await request.json();
  const { currentPassword, newPassword } = body;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) return NextResponse.json({ error: pwError.message }, { status: 400 });

  const dbUser = await identityDb.user.findUnique({
    where: { id: identity.userId },
    select: { passwordHash: true },
  });
  if (!dbUser) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const currentValid = await compare(currentPassword, dbUser.passwordHash);
  if (!currentValid) {
    logSecurityEvent('AUTH_PASSWORD_CHANGED', 'warn', {
      userId: identity.userId,
      details: { result: 'rejected_wrong_current_password' },
    });
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
  }

  const sameAsOld = await compare(newPassword as string, dbUser.passwordHash);
  if (sameAsOld) {
    return NextResponse.json(
      { error: 'New password must be different from the current one' },
      { status: 400 },
    );
  }

  const passwordHash = await hash(newPassword as string, 12);
  await identityDb.user.update({
    where: { id: identity.userId },
    data: { passwordHash, mustChangePassword: false },
  });

  logSecurityEvent('AUTH_PASSWORD_CHANGED', 'info', {
    userId: identity.userId,
    details: { result: 'success' },
  });

  return NextResponse.json({ success: true });
}
