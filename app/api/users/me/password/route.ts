import { NextRequest, NextResponse } from 'next/server';
import { compare, hash } from 'bcryptjs';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/authz';
import { validatePassword } from '@/lib/validate';
import { logSecurityEvent } from '@/lib/security-logger';

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { currentPassword, newPassword } = body;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return NextResponse.json({ error: 'Current password is required' }, { status: 400 });
  }
  const pwError = validatePassword(newPassword);
  if (pwError) return NextResponse.json({ error: pwError.message }, { status: 400 });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!dbUser) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const currentValid = await compare(currentPassword, dbUser.passwordHash);
  if (!currentValid) {
    logSecurityEvent('AUTH_PASSWORD_CHANGED', 'warn', {
      userId: user.id,
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
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword: false },
  });

  logSecurityEvent('AUTH_PASSWORD_CHANGED', 'info', {
    userId: user.id,
    details: { result: 'success' },
  });

  return NextResponse.json({ success: true });
}
