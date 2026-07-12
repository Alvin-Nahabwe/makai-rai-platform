import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeProject } from '@/lib/authz';
import { logSecurityEvent } from '@/lib/security-logger';
import { createAssessment } from '@/lib/engine/AssessmentEngine.js';

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  const assessments = await prisma.assessment.findMany({
    where: { ...(projectId && { projectId }), userId: user.id },
    include: {
      project: { select: { name: true } },
      remediationItems: { select: { id: true, completed: true, tier: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  return NextResponse.json(assessments);
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { projectId, mode = 'full' } = body;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  if (mode !== 'full' && mode !== 'quick') {
    return NextResponse.json({ error: 'mode must be "full" or "quick"' }, { status: 400 });
  }

  // Only the project owner (or an admin) may start an assessment on it.
  const project = await authorizeProject(user, projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const engineState = createAssessment();
  const existingCount = await prisma.assessment.count({ where: { projectId } });

  const assessment = await prisma.assessment.create({
    data: {
      projectId,
      userId: user.id,
      mode,
      engineState,
      version: existingCount + 1,
    },
  });

  logSecurityEvent('ASSESSMENT_CREATED', 'info', {
    userId: user.id,
    details: { assessmentId: assessment.id, projectId, mode },
  });

  return NextResponse.json(assessment, { status: 201 });
}
