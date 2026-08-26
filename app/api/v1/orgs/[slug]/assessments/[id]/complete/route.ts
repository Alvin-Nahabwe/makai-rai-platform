import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { completeAssessment } from '@/lib/data/assessments';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * See `lib/data/assessments.ts#completeAssessment` for why the read of
 * `engineState` and the write of `status`/`reportData`/`overallScore` are
 * now inside one `withOrg` call (fix round 1, Important finding 3), and for
 * O-14's completion half (fix round 2, Critical): the `kind: 'drifted'`
 * case below.
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
      case 'drifted':
        // 409, matching every other O-14 drift refusal in this codebase
        // (the PATCH route, the evidence upload route) — the request
        // conflicts with the assessment's current pinned/deployed-content
        // state. A message distinct from every OTHER case in this switch,
        // for the same reason Task 6 (task-6-report.md) and fix round 1
        // both required it: a shared message made a deleted guard
        // untestable.
        return NextResponse.json(
          {
            error:
              'Framework content has drifted since this assessment was pinned; ' +
              'this assessment cannot be completed until the deployed content matches its pinned version again',
          },
          { status: 409 },
        );
      case 'completed':
        logSecurityEvent('ASSESSMENT_COMPLETED', 'info', {
          userId: identity.userId,
          details: { assessmentId: id, overallScore: result.overallScore },
        });
        return NextResponse.json(result.assessment);
      default: {
        // Exhaustiveness guard (fix round 2): this switch previously had no
        // `default`, so an unhandled `CompleteResult` kind would fall
        // through and return nothing at all — precisely the class of bug a
        // missing `'drifted'` case here would otherwise have been silently.
        const _exhaustive: never = result;
        throw new Error(`assessment complete: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    return toResponse(e);
  }
}
