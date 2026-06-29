import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const assessment = await prisma.assessment.findUnique({
    where: { id },
    include: { project: { select: { name: true, id: true } }, remediationItems: true },
  });
  if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(assessment);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const body = await request.json();
  const { engineState } = body;
  if (!engineState) return NextResponse.json({ error: 'engineState is required' }, { status: 400 });

  const assessment = await prisma.assessment.update({
    where: { id },
    data: { engineState: engineState as any },
  });
  return NextResponse.json(assessment);
}
