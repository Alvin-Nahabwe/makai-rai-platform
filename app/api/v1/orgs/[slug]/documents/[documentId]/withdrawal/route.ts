import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { parseWithdrawDocumentRequest, withdrawDocument } from '@/lib/data/documents';
import { requestDigest } from '@/lib/data/idempotency';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 19: POST to withdraw an issued document with a reason (FR-DOC-06). Same-origin check, the gate
 * (`document:withdraw`: owners and admins), the body's shape, the digest of the path id and the parsed body (`slug` is left out),
 * then the service. 201 with the document; 200 with the same one on a replay; 409 `already_withdrawn`; 404 for a missing or
 * foreign document; 422 on `reason`. Only an event is written: the document and its bytes stay.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; documentId: string }> }) {
  const { slug, documentId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'document:withdraw');
    const request = parseWithdrawDocumentRequest(await readJsonBody(req));
    const digest = requestDigest({ path: { documentId }, body: request });
    const out = await withdrawDocument(ctx, { userId: identity.userId, role: ctx.role }, { ...request, documentId }, digest);
    return NextResponse.json(out.value, { status: out.replayed ? 200 : 201 });
  } catch (e) {
    return toResponse(e);
  }
}
