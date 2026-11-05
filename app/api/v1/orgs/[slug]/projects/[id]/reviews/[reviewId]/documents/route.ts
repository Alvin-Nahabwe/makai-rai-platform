import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { issueDocument, parseDocumentRequest } from '@/lib/data/documents';
import { requestDigest } from '@/lib/data/idempotency';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 16: POST to issue a document (FR-DOC-04). Same-origin check, then the gate (`document:generate`), then the
 * body, then the digest of the path ids and the body (a request id reused against another review answers 409
 * `request_id_reused`; `slug` is left out, finding FID-08), then the service. 201 with the new document; 200 with the same one
 * on a replay. The issuer and the issue time are the session's and the database's, never the body's.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; reviewId: string }> }) {
  const { slug, id, reviewId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'document:generate');
    const request = parseDocumentRequest(await readJsonBody(req), true);
    const digest = requestDigest({ path: { id, reviewId }, body: request });
    const out = await issueDocument(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, reviewId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
