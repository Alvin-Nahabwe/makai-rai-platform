import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { closeByDecision } from '@/lib/data/findings';
import { requestDigest } from '@/lib/data/idempotency';
import { parseCloseByDecision } from '@/lib/findings/validate';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 11: close an open shortfall finding by the decision version that resolved it (FR-FND-06,
 * FR-DEC-08). Same-origin check, the gate (`mitigation:write`), the body's shape, the digest of the path ids and the
 * parsed body, then the service: 201 with the closing mitigation version, 200 for a repeat of the request, 422 on
 * `decisionVersionId` for a version that does not close this finding, 409 `finding_not_open`, and 409
 * `finding_has_open_work` (with a sentence) while one of its mitigations is Planned or In progress (route decision R11).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug, id, findingId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'mitigation:write');
    const request = parseCloseByDecision(await readJsonBody(req));
    const digest = requestDigest({ path: { id, findingId }, body: request });
    const out = await closeByDecision(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, findingId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
