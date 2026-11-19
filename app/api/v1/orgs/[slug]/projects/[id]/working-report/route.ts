import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { parseWorkingReportPart, workingReportPdf } from '@/lib/data/workingReportPdf';
import { navigationRefusal } from '@/lib/http/navigationRefusal';
import { toResponse } from '@/lib/http/toResponse';

/**
 * GET the working report of a project as a draft PDF (path to outputs, Task 9; design G1, §5, §7). `?part=` is one of the report's
 * parts (absent: the whole report); anything else answers 422 on `part`, and a stage's plan for a stage with no answers 404. Every
 * member who can read the record may download it, an archived project's too; nothing is stored (anti-goal 5) and the response is
 * `no-store`, so no cache keeps a draft. The gate runs before the part is read, so a non-member learns nothing from a bad part. The
 * refusals are route 17's (`documents/[documentId]/pdf`): 404 alike for a missing and a foreign project. The name in
 * `Content-Disposition` is the service's, from the part and the date, so it holds no team text.
 */
// No nosniff header here: nginx sets it on every response, once (docker/nginx/default.conf), and a second source fails
// __tests__/lint/security-headers.test.ts.
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    const part = parseWorkingReportPart(req.nextUrl.searchParams.get('part'));
    const { bytes, fileName } = await workingReportPdf(ctx, { userId: identity.userId, role: ctx.role }, id, part);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return navigationRefusal(req, e) ?? toResponse(e);
  }
}
