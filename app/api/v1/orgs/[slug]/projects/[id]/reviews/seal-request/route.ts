import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { requestSeal } from '@/lib/data/reviews';
import { isRequestId, requestDigest } from '@/lib/data/idempotency';
import { ValidationFailed } from '@/lib/http/errors';
import { HTTP_COPY } from '@/lib/http/copy';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { STAGES, type FieldError, type Stage } from '@/types/record';
import { REVIEW_COPY } from '@/lib/review/copy';

const KEYS = ['requestId', 'stage'] as const;

/** The body is exactly `{ requestId, stage }`: any other key, such as a note or a review id, is refused on its field. */
function parseSealRequest(body: unknown): { requestId: string; stage: Stage } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: HTTP_COPY.unreadable }]);
  }
  const extra = Object.keys(body).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { requestId, stage } = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!isRequestId(requestId)) errors.push({ field: 'requestId', message: HTTP_COPY.outOfDate });
  if (!(STAGES as readonly unknown[]).includes(stage)) errors.push({ field: 'stage', message: REVIEW_COPY.open.stageInvalid });
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: requestId as string, stage: stage as Stage };
}

/**
 * The seal request (design G2; SRS FR-DOC-09 clause 10): a role holding `review:open` asks for the stage to be sealed,
 * which returns the stage's open review or opens one. Same-origin check, then the gate (no session 401, not a member
 * 404, a role without `review:open` 403), then the body, then the digest of the path's project id and the body (a request
 * id reused against another project or stage answers 409 `request_id_reused`), then the service. 201 when this request
 * opened the review; 200 when the stage already had one open, or on a replay.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'review:open');
    const request = parseSealRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { id }, body: request });
    const out = await requestSeal(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id }, digest);
    return NextResponse.json(out.value, { status: out.opened ? 201 : 200 });
  } catch (e) {
    return toResponse(e);
  }
}
