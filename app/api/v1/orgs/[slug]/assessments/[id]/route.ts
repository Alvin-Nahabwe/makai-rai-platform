import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContext } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { respondToAssessment } from '@/lib/data/assessments';
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

/**
 * See `lib/data/assessments.ts#respondToAssessment` for why the
 * immutability check and the write are now inside one `withOrg` call
 * (fix round 1, Important finding 3).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const ctx = await requireOrgContext(slug, 'assessment:respond');

    const body = await req.json();
    const { engineState } = body;
    // Accept either a full lifecycle state (has `stages`) or a quick-check
    // state (has `quick`). Anything else is malformed.
    if (!engineState || typeof engineState !== 'object' || (!engineState.stages && !engineState.quick)) {
      return NextResponse.json({ error: 'A valid engineState is required' }, { status: 400 });
    }

    const result = await respondToAssessment(ctx, id, engineState);

    if (result.kind === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (result.kind === 'completed') {
      return NextResponse.json({ error: 'Completed assessments cannot be modified' }, { status: 409 });
    }
    return NextResponse.json(result.assessment);
  } catch (e) {
    return toResponse(e);
  }
}
