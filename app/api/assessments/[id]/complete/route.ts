import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
// @ts-ignore
import { generateReportData } from '@/lib/engine/AssessmentEngine.js';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const assessment = await prisma.assessment.findUnique({ where: { id } });
  if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const reportData = generateReportData(assessment.engineState);
  const updated = await prisma.assessment.update({
    where: { id },
    data: {
      status: 'completed',
      reportData: reportData as any,
      overallScore: Math.round(reportData.overallScore),
      completedAt: new Date(),
    },
  });
  return NextResponse.json(updated);
}
