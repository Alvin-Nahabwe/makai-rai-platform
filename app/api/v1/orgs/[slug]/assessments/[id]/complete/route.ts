import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { completeAssessment } from '@/lib/data/assessments';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * See `lib/data/assessments.ts#completeAssessment` for why the read of
 * `engineState` and the write of `status`/`reportData`/`overallScore` are
 * now inside one `withOrg` call (fix round 1, Important finding 3).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'assessment:complete');

    const result = await completeAssessment(ctx, id);

    switch (result.kind) {
      case 'not_found':
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'already_completed':
        return NextResponse.json(result.assessment);
      case 'no_responses':
        return NextResponse.json(
          { error: 'Answer the quick check questions before finishing' },
          { status: 400 },
        );
      case 'no_stages':
        return NextResponse.json(
          { error: 'Complete at least one lifecycle stage before finishing the assessment' },
          { status: 400 },
        );
      case 'completed':
        logSecurityEvent('ASSESSMENT_COMPLETED', 'info', {
          userId: identity.userId,
          details: { assessmentId: id, mode: result.mode, overallScore: result.overallScore },
        });
        return NextResponse.json(result.assessment);
    }
  } catch (e) {
    return toResponse(e);
  }
}
