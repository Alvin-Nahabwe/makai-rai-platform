import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { currentDecisions } from '@/lib/data/decisions';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { ValidationFailed } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { STAGES, type Stage } from '@/types/record';

/**
 * Contract route 48 (FR-OPS-01; NFR-SEC-02): GET the current version of one question in one stage, as
 * `{ current: DecisionVersionView | null }`. The synthetic journey reads a fixed decision with it before and
 * after its save; the screens read the same data through the service.
 *
 * Gate: `record:read` through requireOrgContextWithIdentity (no session 401, not a member 404, a role without
 * the action 403). The project is looked up first inside the organisation's transaction: row-level security
 * makes another organisation's project and a project that never existed the same 404, where the service alone
 * would answer `{ current: null }` for both. `stage` must be one of STAGES, else 422 on field `stage`.
 * A withdrawal is a current version, and a question whose current version is in another stage answers null.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string; questionId: string }> },
) {
  const { slug, id, questionId } = await params;
  try {
    const { ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    const stage = req.nextUrl.searchParams.get('stage');
    if (stage === null || !(STAGES as readonly string[]).includes(stage)) {
      throw new ValidationFailed([{ field: 'stage', message: 'Choose one of the three stages.' }]);
    }
    const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true } }));
    if (!project) throw new NotFoundError();
    const current = (await currentDecisions(ctx, id, stage as Stage)).get(questionId) ?? null;
    return NextResponse.json({ current });
  } catch (e) {
    return toResponse(e);
  }
}
