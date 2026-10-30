import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { saveDecision } from '@/lib/data/decisions';
import { requestDigest } from '@/lib/data/idempotency';
import { parseSaveDecisionRequest, readJsonBody } from '@/lib/decision/parse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 1: save a decision version (FR-DEC-01 to 05, 07, 09). Same-origin check, then the gate
 * (no session 401, not a member 404, a role without `decision:write` 403), then the body's shape, then the
 * digest of the path ids and the parsed body (so a request id reused against another project answers 409
 * `request_id_reused`, contract Services intro), then the service. 201 with the new version; 200 with the
 * same body when the request id was seen before ("already saved as version N", FR-DEC-07). The response is
 * built only after the service's transaction has committed (NFR-REL-04). POST only: no autosave or draft
 * endpoint exists on the server (UX-24).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'decision:write');
    const request = parseSaveDecisionRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { id }, body: request });
    const out = await saveDecision(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
