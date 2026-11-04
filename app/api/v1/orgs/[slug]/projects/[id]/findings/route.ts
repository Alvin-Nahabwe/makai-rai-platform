import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestDigest } from '@/lib/data/idempotency';
import { parseRaiseTeamFinding, raiseTeamFinding } from '@/lib/data/teamFindings';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 5: raise a team finding (FR-FND-02). Same-origin check, then the gate (no session 401, not a member 404, a
 * role without `finding:raise` 403), then the body's shape, then the digest of the path (the project id) and the parsed body
 * (so a request id reused against another project answers 409 `request_id_reused`, contract Services intro), then the
 * service. 201 with the finding; 200 with the same body when the request id was seen before.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'finding:raise');
    const request = parseRaiseTeamFinding(await readJsonBody(req));
    const digest = requestDigest({ path: { id }, body: request });
    const out = await raiseTeamFinding(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
