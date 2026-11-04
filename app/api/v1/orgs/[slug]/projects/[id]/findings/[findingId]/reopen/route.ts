import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { reopenFinding } from '@/lib/data/findings';
import { requestDigest } from '@/lib/data/idempotency';
import { parseFindingEvent } from '@/lib/findings/validate';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 9: reopen a closed finding with a reason (FR-FND-07). Same-origin check, the gate (`finding:reopen`),
 * the body's shape, the digest of the path ids and the parsed body, then the service: 201 with the event, 200 for a
 * repeat of the request, 409 `finding_withdrawn` or `finding_already_open` for a withdrawn or an open finding.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug, id, findingId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'finding:reopen');
    const request = parseFindingEvent(await readJsonBody(req));
    const digest = requestDigest({ path: { id, findingId }, body: request });
    const out = await reopenFinding(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, findingId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
