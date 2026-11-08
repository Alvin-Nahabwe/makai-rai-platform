import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { readDocumentText } from '@/lib/data/documents';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 18: GET the plain-text copy of an issued document (FR-DOC-07). Any member may read it (`record:read`). The body is
 * the marking line, a blank line and the text stored at issue, answered as `text/plain; charset=utf-8` so team text is never read as
 * markup (NFR-SEC-11), with no `Content-Disposition`: S-18 copies it. 404 alike for a missing and a foreign document, 410 `erased`
 * once the operator erased the document.
 */
// No nosniff header here: nginx sets it on every response, once (docker/nginx/default.conf), and a second source fails
// __tests__/lint/security-headers.test.ts.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string; documentId: string }> }) {
  const { slug, documentId } = await params;
  try {
    const { ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    const text = await readDocumentText(ctx, documentId);
    return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (e) {
    return toResponse(e);
  }
}
