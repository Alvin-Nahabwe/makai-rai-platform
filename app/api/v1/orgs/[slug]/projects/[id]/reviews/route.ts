import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { openStageReview } from '@/lib/data/reviews';
import { isRequestId, requestDigest } from '@/lib/data/idempotency';
import { ValidationFailed } from '@/lib/http/errors';
import { HTTP_COPY } from '@/lib/http/copy';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';
import { STAGES, type FieldError, type Stage } from '@/types/record';
import type { OpenReviewRequest } from '@/types/api';
import { REVIEW_COPY } from '@/lib/review/copy';

const KEYS = ['requestId', 'stage', 'preparedFor'] as const;

/**
 * The body is exactly `OpenReviewRequest` (obligation B2): any other key, such as a name, a number or an opener, is
 * refused on its field, since the platform names the review, numbers it and takes the opener from the session
 * (FR-REV-01, R-70). Types only here; the note's length is the service's rule.
 */
function parseOpenReviewRequest(body: unknown): OpenReviewRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: HTTP_COPY.unreadable }]);
  }
  const extra = Object.keys(body).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { requestId, stage, preparedFor } = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!isRequestId(requestId)) errors.push({ field: 'requestId', message: HTTP_COPY.outOfDate });
  if (!(STAGES as readonly unknown[]).includes(stage)) errors.push({ field: 'stage', message: REVIEW_COPY.open.stageInvalid });
  if (preparedFor !== null && typeof preparedFor !== 'string') errors.push({ field: 'preparedFor', message: REVIEW_COPY.open.noteInvalid });
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: requestId as string, stage: stage as Stage, preparedFor: preparedFor as string | null };
}

/**
 * Contract route row 12: open a stage review (FR-REV-01). Same-origin check, then the gate (no session 401, not a
 * member 404, a role without `review:open` 403), then the body, then the digest of the path's project id and the body
 * (so a request id reused against another project answers 409 `request_id_reused`, contract Services intro; `slug` is
 * left out), then the service. 201 with the new review; 200 with the same review on a replay. Nothing here logs the
 * note (NFR-PRIV-03).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'review:open');
    const request = parseOpenReviewRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { id }, body: request });
    const out = await openStageReview(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
