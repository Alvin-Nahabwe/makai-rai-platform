import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { readDocumentPdf } from '@/lib/data/documents';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Contract route row 17: GET the stored bytes of an issued document (FR-DOC-04, NFR-INT-06). The service compares their
 * SHA-256 with the stored one before anything is sent and nothing is regenerated. 404 alike for a missing and a foreign
 * document, 410 `erased` once the operator erased the bytes, 500 `integrity_failure` for bytes that do not match. The name in
 * `Content-Disposition` is made by the service from the type, the date and the id, so it holds no team text.
 */
// No nosniff header here: nginx sets it on every response, once (docker/nginx/default.conf), and a second source fails
// __tests__/lint/security-headers.test.ts.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string; documentId: string }> }) {
  const { slug, documentId } = await params;
  try {
    const { ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    const { bytes, fileName } = await readDocumentPdf(ctx, documentId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(bytes.byteLength),
      },
    });
  } catch (e) {
    return toResponse(e);
  }
}
