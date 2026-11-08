import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { parseDocumentRequest, previewDocument } from '@/lib/data/documents';
import { readJsonBody } from '@/lib/http/jsonBody';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 15: POST to preview a document (FR-DOC-08). It writes nothing and takes no request id. Same-origin
 * check, then the gate (no session 401, not a member 404, a role without `document:generate` 403), then the body, then the
 * service, which reads one snapshot and renders the text as it will print.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string; reviewId: string }> }) {
  const { slug, id, reviewId } = await params;
  try {
    assertSameOrigin(req);
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'document:generate');
    const request = parseDocumentRequest(await readJsonBody(req), false);
    return NextResponse.json(await previewDocument(ctx, { userId: identity.userId, role: ctx.role }, { ...request, projectId: id, reviewId }));
  } catch (e) {
    return toResponse(e);
  }
}
