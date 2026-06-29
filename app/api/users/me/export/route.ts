import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as any).id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      projects: { include: { metadata: true, assessments: { include: { remediationItems: true } } } },
      consentRecords: true,
    },
  });

  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { passwordHash, ...safeUser } = user;
  return NextResponse.json(safeUser, {
    headers: {
      'Content-Disposition': `attachment; filename="makrai-export-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
}
