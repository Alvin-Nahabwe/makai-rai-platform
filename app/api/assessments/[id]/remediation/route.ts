import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const items = await prisma.remediationItem.findMany({
    where: { assessmentId: id },
    include: { completedBy: { select: { name: true } } },
    orderBy: [{ tier: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json(items);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const body = await request.json();
  const { items } = body;

  if (!items || !Array.isArray(items)) {
    return NextResponse.json({ error: 'items array is required' }, { status: 400 });
  }

  const created = await prisma.remediationItem.createMany({
    data: items.map((item: any) => ({
      assessmentId: id, areaId: item.areaId, areaName: item.areaName,
      tier: item.tier, description: item.description,
    })),
  });
  return NextResponse.json({ count: created.count }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json();
  const { itemId, completed, completionNotes, evidenceLevel } = body;
  if (!itemId) return NextResponse.json({ error: 'itemId is required' }, { status: 400 });

  const userId = (session.user as any).id;
  const item = await prisma.remediationItem.update({
    where: { id: itemId },
    data: {
      completed: completed ?? undefined,
      completedAt: completed ? new Date() : null,
      completedById: completed ? userId : null,
      completionNotes: completionNotes ?? undefined,
      evidenceLevel: evidenceLevel ?? undefined,
    },
  });
  return NextResponse.json(item);
}
