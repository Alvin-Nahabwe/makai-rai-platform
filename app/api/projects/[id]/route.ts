import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeProject } from '@/lib/authz';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeProject(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      metadata: true,
      assessments: {
        include: {
          user: { select: { name: true, email: true } },
          remediationItems: true,
        },
        orderBy: { startedAt: 'desc' },
      },
      createdBy: { select: { name: true } },
    },
  });

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(project);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeProject(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json();
  const { name, description, ...metadataFields } = body;

  const project = await prisma.project.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(description !== undefined && { description }),
      metadata: {
        upsert: {
          create: metadataFields,
          update: metadataFields,
        },
      },
    },
    include: { metadata: true },
  });
  return NextResponse.json(project);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeProject(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
