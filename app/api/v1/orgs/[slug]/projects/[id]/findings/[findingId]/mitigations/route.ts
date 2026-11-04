import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { addMitigation } from '@/lib/data/findings';
import { requestDigest } from '@/lib/data/idempotency';
import { parseAddMitigation } from '@/lib/findings/validate';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 6: add a mitigation to an open finding (FR-FND-03, FR-FND-04). Same-origin check, then the gate (no
 * session 401, not a member 404, a role without `mitigation:write` 403), then the body's shape, then the digest of the
 * path ids and the parsed body (so a request id reused against another finding answers 409 `request_id_reused`), then
 * the service. 201 with version 1; 200 with the same body when the request id was seen before (FR-DEC-07).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug, id, findingId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'mitigation:write');
    const request = parseAddMitigation(await readJsonBody(req));
    const digest = requestDigest({ path: { id, findingId }, body: request });
    const out = await addMitigation(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, findingId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
