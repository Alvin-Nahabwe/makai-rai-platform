import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { acceptRisk } from '@/lib/data/findings';
import { requestDigest } from '@/lib/data/idempotency';
import { parseAcceptRisk } from '@/lib/findings/validate';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 8: accept the risk of an open finding, or keep an accepted risk after looking at it again
 * (FR-FND-05). Same-origin check, the gate (`risk:accept`: owners and admins), the body's shape, the digest of the path
 * ids and the parsed body, then the service: 201 with the accepted risk, 200 for a repeat of the request, 409
 * `finding_not_open` with who closed the finding and when (7.4.4).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug, id, findingId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'risk:accept');
    const request = parseAcceptRisk(await readJsonBody(req));
    const digest = requestDigest({ path: { id, findingId }, body: request });
    const out = await acceptRisk(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, findingId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
