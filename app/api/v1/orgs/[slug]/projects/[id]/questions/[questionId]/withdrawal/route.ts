import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withdrawDecision } from '@/lib/data/decisions';
import { requestDigest } from '@/lib/data/idempotency';
import { parseWithdrawDecisionRequest, readJsonBody } from '@/lib/decision/parse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 2: withdraw a question's current decision as a new version (FR-DEC-08). Same-origin
 * check, then the gate (no session 401, not a member 404, a role without `decision:withdraw` 403), then the
 * body's shape, then the digest of the path ids `{ id, questionId }` and the parsed body, then the service,
 * which also applies the object rule (an assessor withdraws only a version they entered: 403). 201 with the
 * withdrawal version; 200 with the same body for a replay (FR-DEC-07). POST only (UX-24).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; questionId: string }> }) {
  const { slug, id, questionId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'decision:withdraw');
    const request = parseWithdrawDecisionRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { id, questionId }, body: request });
    const out = await withdrawDecision(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, questionId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
