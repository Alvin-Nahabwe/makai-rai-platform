// app/api/research/export/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== 'admin') {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  }

  const consented = await prisma.consentRecord.findMany({
    where: { consentType: 'research_data_usage', granted: true },
    select: { userId: true },
  });
  const consentedIds = consented.map((c) => c.userId);

  const assessments = await prisma.assessment.findMany({
    where: { userId: { in: consentedIds }, status: 'completed' },
    include: { project: { include: { metadata: true } } },
  });

  const anonymized = assessments.map((a) => ({
    projectMetadata: {
      aiSystemType: a.project.metadata?.aiSystemType,
      institution: a.project.metadata?.institution,
      deploymentSector: a.project.metadata?.deploymentSector,
      developmentStage: a.project.metadata?.developmentStage,
      datasetSize: a.project.metadata?.datasetSize,
      country: a.project.metadata?.country,
      teamSize: a.project.metadata?.teamSize,
    },
    assessmentMode: a.mode,
    overallScore: a.overallScore,
    reportData: a.reportData,
    completedAt: a.completedAt,
  }));

  return NextResponse.json(anonymized, {
    headers: { 'Content-Disposition': `attachment; filename="makrai-research-${new Date().toISOString().split('T')[0]}.json"` },
  });
}
