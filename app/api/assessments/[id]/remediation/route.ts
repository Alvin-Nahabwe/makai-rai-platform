import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser, authorizeAssessment, isAdmin } from '@/lib/authz';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const items = await prisma.remediationItem.findMany({
    where: { assessmentId: id },
    include: { completedBy: { select: { name: true } } },
    orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json(items);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json();
  const { items } = body;

  if (!items || !Array.isArray(items)) {
    return NextResponse.json({ error: 'items array is required' }, { status: 400 });
  }

  const created = await prisma.remediationItem.createMany({
    data: items.map((item: { areaId: string; areaName: string; tier: string; description: string }) => ({
      assessmentId: id,
      areaId: item.areaId,
      areaName: item.areaName,
      tier: item.tier as 'gap' | 'attention',
      description: item.description,
    })),
  });
  return NextResponse.json({ count: created.count }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const authorized = await authorizeAssessment(user, id);
  if (!authorized) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json();
  const { itemId, completed, completionNotes, evidenceLevel } = body;
  if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 });

  // The item must belong to this assessment — never trust a raw itemId that
  // could point at another user's remediation item.
  const existing = await prisma.remediationItem.findUnique({
    where: { id: itemId },
    select: { assessmentId: true },
  });
  if (!existing || (existing.assessmentId !== id && !isAdmin(user))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const item = await prisma.remediationItem.update({
    where: { id: itemId },
    data: {
      completed: completed ?? undefined,
      completedAt: completed ? new Date() : null,
      completedById: completed ? user.id : null,
      completionNotes: completionNotes ?? undefined,
      evidenceLevel: evidenceLevel ?? undefined,
    },
  });
  return NextResponse.json(item);
}
