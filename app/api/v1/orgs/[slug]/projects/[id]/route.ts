import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { toResponse } from '@/lib/http/toResponse';

/**
 * No `user`/`createdBy` relation `include` anywhere below — `makrai_app`
 * has no grant on `users` (see lib/data/identity.ts#lookupUserNames).
 * Scalar `userId`/`createdById` columns are read directly off the tenant
 * rows and names are attached afterwards via `lookupUserNames`.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'project:read');
    const project = await withOrg(ctx, (tx) =>
      tx.project.findUnique({
        where: { id },
        include: {
          metadata: true,
          assessments: {
            include: { remediationItems: true },
            orderBy: { startedAt: 'desc' },
          },
        },
      }),
    );
    // RLS scopes `id` to this org; a project belonging to another org or one
    // that never existed is INDISTINGUISHABLE here — both come back null.
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const names = await lookupUserNames([
      project.createdById,
      ...project.assessments.map((a) => a.userId),
    ]);
    const withNames = {
      ...project,
      createdBy: names.get(project.createdById) ?? null,
      assessments: project.assessments.map((a) => ({ ...a, user: names.get(a.userId) ?? null })),
    };
    return NextResponse.json(withNames);
  } catch (e) {
    return toResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'project:update');
    const body = await req.json();
    const { name, description, ...metadataFields } = body;

    const project = await withOrg(ctx, (tx) =>
      tx.project.update({
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
      }),
    );
    return NextResponse.json(project);
  } catch (e) {
    // Prisma throws P2025 ("record not found") on an update whose `where`
    // matches no row under the current GUC — a project in another org
    // reads exactly like a project that never existed. Treat it the same
    // as every other not-found in this route.
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2025') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return toResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'project:delete');
    await withOrg(ctx, (tx) => tx.project.delete({ where: { id } }));
    return NextResponse.json({ success: true });
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2025') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return toResponse(e);
  }
}
