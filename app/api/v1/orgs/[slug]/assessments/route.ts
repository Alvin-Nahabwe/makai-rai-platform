import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { requireOrgContext, requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { getCurrentVersionId } from '@/lib/data/framework';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';
import { createAssessment } from '@/lib/engine/AssessmentEngine.js';

/**
 * `projectId` is a DOMAIN filter (narrow to one project's assessments), not
 * a tenant filter — legitimate to keep. There is no `userId` filter: any
 * org member with `assessment:read` sees every assessment in the org, the
 * same team-visibility model `project:read` uses (ADR-0001, lib/authz.ts's
 * deletion rationale).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:read');
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get('projectId');

    const assessments = await withOrg(ctx, (tx) =>
      tx.assessment.findMany({
        where: { ...(projectId && { projectId }) },
        include: {
          project: { select: { name: true } },
          remediationItems: { select: { id: true, completed: true, tier: true } },
        },
        orderBy: { startedAt: 'desc' },
      }),
    );
    return NextResponse.json(assessments);
  } catch (e) {
    return toResponse(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'assessment:create');

    const body = await req.json();
    const { projectId, mode = 'full' } = body;
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    // D-012/D-131: Quick Check is retired. `AssessmentMode.quick` stays a
    // valid enum value (existing rows carry it) but creating a NEW one is
    // no longer accepted — there is no live UI flow left to answer it.
    if (mode !== 'full') {
      return NextResponse.json({ error: 'mode must be "full"' }, { status: 400 });
    }

    const engineState = createAssessment();

    const assessment = await withOrg(ctx, async (tx) => {
      // The project must exist IN THIS ORG — RLS returns null for a project
      // belonging to another org exactly as it would for an unknown id, so
      // this is authorization-free existence checking, not a second filter.
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) return null;

      // The write half of the pin (fix round 1, 2026-08-07): resolves to the
      // framework_versions row the currently-deployed content corresponds
      // to. Throws (not a fallback) if none is published — see
      // lib/data/framework.ts's resolvePublishedVersionId. Deliberately
      // inside this same withOrg transaction, not a second one: a project
      // that exists but an unpinnable assessment must not create a partial
      // row, and there is nothing here to roll back independently of the
      // create below.
      const frameworkVersionId = await getCurrentVersionId(tx);

      const existingCount = await tx.assessment.count({ where: { projectId } });
      // `orgId: ctx.orgId` on an INSERT is a value being written and
      // WITH-CHECK-verified against the GUC, not a read filter — see the
      // identical comment on the project-create route for why this is not
      // the "app filter that masks RLS" pattern (ADR-0001).
      return tx.assessment.create({
        data: {
          orgId: ctx.orgId,
          projectId,
          userId: identity.userId,
          mode,
          frameworkVersionId,
          engineState: engineState as unknown as Prisma.InputJsonValue,
          version: existingCount + 1,
        },
      });
    });

    if (!assessment) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    logSecurityEvent('ASSESSMENT_CREATED', 'info', {
      userId: identity.userId,
      details: { assessmentId: assessment.id, projectId, mode },
    });

    return NextResponse.json(assessment, { status: 201 });
  } catch (e) {
    return toResponse(e);
  }
}
