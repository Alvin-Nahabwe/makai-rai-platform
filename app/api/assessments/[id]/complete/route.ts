import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeAssessment } from '@/lib/authz';
import { logSecurityEvent } from '@/lib/security-logger';
import { generateReportData, canGenerateReport } from '@/lib/engine/AssessmentEngine.js';
import { getQuickScore } from '@/lib/engine/QuickAssessment.js';
import type { EngineState } from '@/types/domain';

/** Shape persisted for a quick assessment (no lifecycle stages). */
interface QuickState {
  mode: 'quick';
  quick: { responses: Record<string, number> };
}

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

  // Quick assessments use the curated 10-question engine, not lifecycle stages.
  if (assessment.mode === 'quick') {
    const quickState = assessment.engineState as unknown as QuickState;
    const responses = quickState?.quick?.responses ?? {};
    if (Object.keys(responses).length === 0) {
      return NextResponse.json(
        { error: 'Answer the quick check questions before finishing' },
        { status: 400 },
      );
    }
    const overallScore = getQuickScore(responses);
    const updated = await prisma.assessment.update({
      where: { id },
      data: {
        status: 'completed',
        reportData: { mode: 'quick', overallScore, completedStages: [], generatedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
        overallScore,
        completedAt: new Date(),
      },
    });
    logSecurityEvent('ASSESSMENT_COMPLETED', 'info', {
      userId: user.id,
      details: { assessmentId: id, mode: 'quick', overallScore },
    });
    return NextResponse.json(updated);
  }

  // Score is computed server-side from the persisted engine state so it cannot
  // be forged by the client. Require at least one completed stage.
  const engineState = assessment.engineState as unknown as EngineState;
  if (!canGenerateReport(engineState)) {
    return NextResponse.json(
      { error: 'Complete at least one lifecycle stage before finishing the assessment' },
      { status: 400 },
    );
  }

  const reportData = generateReportData(engineState);
  const updated = await prisma.assessment.update({
    where: { id },
    data: {
      status: 'completed',
      reportData: reportData as unknown as Prisma.InputJsonValue,
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
