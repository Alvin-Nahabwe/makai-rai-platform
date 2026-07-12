import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeAssessment } from '@/lib/authz';
import { logSecurityEvent } from '@/lib/security-logger';
import { generateReportData, canGenerateReport } from '@/lib/engine/AssessmentEngine.js';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const assessment = await prisma.assessment.findUnique({ where: { id } });
  if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Idempotency: a completed assessment keeps its original score/report.
  if (assessment.status === 'completed') {
    return NextResponse.json(assessment);
  }

  // Score is computed server-side from the persisted engine state so it cannot
  // be forged by the client. Require at least one completed stage.
  if (!canGenerateReport(assessment.engineState)) {
    return NextResponse.json(
      { error: 'Complete at least one lifecycle stage before finishing the assessment' },
      { status: 400 },
    );
  }

  const reportData = generateReportData(assessment.engineState);
  const updated = await prisma.assessment.update({
    where: { id },
    data: {
      status: 'completed',
      reportData,
      overallScore: Math.round(reportData.overallScore),
      completedAt: new Date(),
    },
  });

  logSecurityEvent('ASSESSMENT_COMPLETED', 'info', {
    userId: user.id,
    details: { assessmentId: id, overallScore: updated.overallScore },
  });

  return NextResponse.json(updated);
}
