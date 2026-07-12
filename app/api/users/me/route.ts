import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const body = await request.json();
  const { confirmation } = body;

  if (confirmation !== 'DELETE MY ACCOUNT') {
    return NextResponse.json({ error: 'Type "DELETE MY ACCOUNT" to confirm' }, { status: 400 });
  }

  // Delete in order: remediation items, assessments, project metadata, projects, consent records, user
  await prisma.$transaction([
    prisma.remediationItem.deleteMany({ where: { assessment: { userId } } }),
    prisma.assessment.deleteMany({ where: { userId } }),
    prisma.projectMetadata.deleteMany({ where: { project: { createdById: userId } } }),
    prisma.project.deleteMany({ where: { createdById: userId } }),
    prisma.consentRecord.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);

  return NextResponse.json({ success: true, message: 'Account and all associated data deleted.' });
}
