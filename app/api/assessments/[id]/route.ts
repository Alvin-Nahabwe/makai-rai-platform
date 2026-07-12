import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeAssessment } from '@/lib/authz';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const assessment = await prisma.assessment.findUnique({
    where: { id },
    include: { project: { select: { name: true, id: true } }, remediationItems: true },
  });
  if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(assessment);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A completed assessment is immutable — its score is a record of a point in
  // time. Reject edits rather than silently letting the report drift.
  if (authorized.status === 'completed') {
    return NextResponse.json({ error: 'Completed assessments cannot be modified' }, { status: 409 });
  }

  const body = await request.json();
  const { engineState } = body;
  if (!engineState || typeof engineState !== 'object' || !engineState.stages) {
    return NextResponse.json({ error: 'A valid engineState is required' }, { status: 400 });
  }

  const assessment = await prisma.assessment.update({
    where: { id },
    data: { engineState },
  });
  return NextResponse.json(assessment);
}
