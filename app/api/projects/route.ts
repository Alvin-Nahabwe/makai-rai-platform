import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = (session.user as any).id;
  const role = (session.user as any).role;

  const projects = await prisma.project.findMany({
    where: role === 'admin' ? {} : { createdById: userId },
    include: {
      metadata: true,
      assessments: {
        select: { id: true, status: true, overallScore: true, completedAt: true, mode: true },
        orderBy: { startedAt: 'desc' },
      },
      createdBy: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  return NextResponse.json(projects);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, description, aiSystemType, ...metadataFields } = body;

  if (!name) return NextResponse.json({ error: 'Project name is required' }, { status: 400 });

  const userId = (session.user as any).id;
  const project = await prisma.project.create({
    data: {
      name,
      description: description || null,
      createdById: userId,
      metadata: {
        create: {
          aiSystemType: aiSystemType || null,
          ...Object.fromEntries(
            Object.entries(metadataFields).filter(([, v]) => v !== undefined && v !== ''),
          ),
        },
      },
    },
    include: { metadata: true },
  });

  return NextResponse.json(project, { status: 201 });
}
