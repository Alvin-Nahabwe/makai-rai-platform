import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { updateMitigation } from '@/lib/data/findings';
import { requestDigest } from '@/lib/data/idempotency';
import { parseUpdateMitigation } from '@/lib/findings/validate';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 7: the next version of a mitigation, based on the version the person last saw (FR-FND-03, IC-7).
 * Same-origin check, the gate (`mitigation:write`), the body's shape, the digest of the path ids (the mitigation's
 * included) and the parsed body, then the service: 201 with the new version, 200 for a repeat of the request, 409
 * `base_version_moved` with the current version when the base is not the current one.
 */
export async function POST(
  req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; findingId: string; mitigationId: string }> },
) {
  const { slug, id, findingId, mitigationId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'mitigation:write');
    const request = parseUpdateMitigation(await readJsonBody(req));
    const digest = requestDigest({ path: { id, findingId, mitigationId }, body: request });
    const out = await updateMitigation(
      ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, findingId, mitigationId }, digest,
    );
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
