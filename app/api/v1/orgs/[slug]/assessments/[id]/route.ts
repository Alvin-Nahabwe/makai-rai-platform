import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { toResponse } from '@/lib/http/toResponse';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:read');
    const assessment = await withOrg(ctx, (tx) =>
      tx.assessment.findUnique({
        where: { id },
        include: { project: { select: { name: true, id: true } }, remediationItems: true },
      }),
    );
    if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(assessment);
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
    const ctx = await requireOrgContext(slug, 'assessment:respond');

    const existing = await withOrg(ctx, (tx) =>
      tx.assessment.findUnique({ where: { id }, select: { status: true } }),
    );
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // A completed assessment is immutable — its score is a record of a
    // point in time. Reject edits rather than silently letting the report
    // drift.
    if (existing.status === 'completed') {
      return NextResponse.json({ error: 'Completed assessments cannot be modified' }, { status: 409 });
    }

    const body = await req.json();
    const { engineState } = body;
    // Accept either a full lifecycle state (has `stages`) or a quick-check
    // state (has `quick`). Anything else is malformed.
    if (!engineState || typeof engineState !== 'object' || (!engineState.stages && !engineState.quick)) {
      return NextResponse.json({ error: 'A valid engineState is required' }, { status: 400 });
    }

    const assessment = await withOrg(ctx, (tx) =>
      tx.assessment.update({ where: { id }, data: { engineState } }),
    );
    return NextResponse.json(assessment);
  } catch (e) {
    return toResponse(e);
  }
}
