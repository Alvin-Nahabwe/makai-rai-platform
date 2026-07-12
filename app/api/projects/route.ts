import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/authz';
import { validateString } from '@/lib/validate';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projects = await prisma.project.findMany({
    where: user.role === 'admin' ? {} : { createdById: user.id },
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
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { description, aiSystemType, ...metadataFields } = body;

  const nameResult = validateString(body.name, 'Project name', 200);
  if (nameResult.error) {
    return NextResponse.json({ error: nameResult.error.message }, { status: 400 });
  }
  const descResult = validateString(description, 'Description', 2000, false);
  if (descResult.error) {
    return NextResponse.json({ error: descResult.error.message }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      name: nameResult.value,
      description: descResult.value || null,
      createdById: user.id,
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
