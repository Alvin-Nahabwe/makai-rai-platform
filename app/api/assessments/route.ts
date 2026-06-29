import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
// @ts-ignore — JS module
import { createAssessment } from '@/lib/engine/AssessmentEngine.js';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const userId = (session.user as any).id;

  const assessments = await prisma.assessment.findMany({
    where: { ...(projectId && { projectId }), userId },
    include: {
      project: { select: { name: true } },
      remediationItems: { select: { id: true, completed: true, tier: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  return NextResponse.json(assessments);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { projectId, mode = 'full' } = body;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const engineState = createAssessment();
  const existingCount = await prisma.assessment.count({ where: { projectId } });

  const assessment = await prisma.assessment.create({
    data: {
      projectId,
      userId: (session.user as any).id,
      mode: mode as any,
      engineState: engineState as any,
      version: existingCount + 1,
    },
  });

  return NextResponse.json(assessment, { status: 201 });
}
