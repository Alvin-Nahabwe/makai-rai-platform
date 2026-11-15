import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { sealStageReview } from '@/lib/data/seals';
import { isRequestId, requestDigest } from '@/lib/data/idempotency';
import { ValidationFailed } from '@/lib/http/errors';
import { HTTP_COPY } from '@/lib/http/copy';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import type { SealRequest } from '@/types/api';

/**
 * The body is exactly `SealRequest` (obligation A1): any other key, such as a manifest, a sealer, a time or a
 * number, is refused on its field, since every value a seal holds comes from the server's rows, the session and
 * the database clock.
 */
/** Exported for the unit test of its messages (lane 6, FX3); not part of the route's contract. */
export function parseSealRequest(body: unknown): SealRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: HTTP_COPY.unreadable }]);
  }
  const extra = Object.keys(body).filter((k) => k !== 'requestId');
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { requestId } = body as { requestId?: unknown };
  if (!isRequestId(requestId)) throw new ValidationFailed([{ field: 'requestId', message: HTTP_COPY.outOfDate }]);
  return { requestId };
}

/**
 * Contract route row 13: seal a stage review (FR-REV-03). Same-origin check, then the gate (no session 401, not a
 * member 404, a role without `review:seal` 403), then the body, then the digest of the path ids and the body (so a
 * request id reused against another review answers 409 `request_id_reused`, contract Services intro; `slug` is
 * left out, finding FID-08), then the service. 201 with the new seal; 200 with the same seal on a replay.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; reviewId: string }> }) {
  const { slug, id, reviewId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'review:seal');
    const request = parseSealRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { id, reviewId }, body: request });
    const out = await sealStageReview(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, reviewId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
