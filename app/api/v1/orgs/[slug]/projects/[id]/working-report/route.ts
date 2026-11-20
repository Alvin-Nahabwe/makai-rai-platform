import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { parseWorkingReportPart, workingReportPdf, WorkingReportBusyError } from '@/lib/data/workingReportPdf';
import { RequestAbortedError } from '@/lib/concurrency/limiter';
import { isNavigation, navigationRefusal } from '@/lib/http/navigationRefusal';
import { reportRefusalLocation, type ReportRefusal } from '@/lib/http/exportRefusal';
import { publicOrigin } from '@/lib/publicOrigin';
import { toResponse } from '@/lib/http/toResponse';

/**
 * GET the working report of a project as a draft PDF (path to outputs, Task 9; design G1, §5, §7). `?part=` is one of the report's
 * parts (absent: the whole report); anything else answers 422 on `part`, and a stage's plan for a stage with no answers 404. Every
 * member who can read the record may download it, an archived project's too; nothing is stored (anti-goal 5) and the response is
 * `no-store`, so no cache keeps a draft. The gate runs before the part is read, so a non-member learns nothing from a bad part. The
 * refusals are route 17's (`documents/[documentId]/pdf`): 404 alike for a missing and a foreign project. The name in
 * `Content-Disposition` is the service's, from the part and the date, so it holds no team text.
 *
 * Under load (Task 16 fix, round 2): a download that gets no render lane in time answers 503 `report_busy` with `Retry-After`. One
 * whose client has gone while it waited answers 499 (nginx's "client closed request") with no body and no failure logged: nobody
 * is there to read it, and it is not a fault.
 *
 * The download links are plain anchors (fix wave item 8; silent-failure audit I1). A browser NAVIGATION refused with 503 `report_busy`,
 * a server fault, 422 `part` or 404 goes back to the report page with the reason in the query (and a fault's support reference), as
 * the team export does for `export_busy`; the JSON answer is still made first, so a fault is logged under its reference as before.
 * Every 404 gets the same redirect whatever its cause, and the report page itself answers 404 for a project the organisation does
 * not hold, so the redirect tells nothing the page does not. Anything that is not a navigation keeps the JSON. HEAD takes no render
 * lane (fix wave item 13; final review M5): Next answers HEAD with this handler, so it is refused here, as the export route does.
 */
// No nosniff header here: nginx sets it on every response, once (docker/nginx/default.conf), and a second source fails
// __tests__/lint/security-headers.test.ts.
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  if (req.method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const { slug, id } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    const part = parseWorkingReportPart(req.nextUrl.searchParams.get('part'));
    const { bytes, fileName } = await workingReportPdf(ctx, { userId: identity.userId, role: ctx.role }, id, part, req.signal);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof RequestAbortedError) return new Response(null, { status: 499 });
    const session = navigationRefusal(req, e);
    if (session !== null) return session;
    const res = toResponse(e);
    // toResponse puts the wait in the body only; the header is this route's, as proxy.ts adds it to its own 429.
    if (e instanceof WorkingReportBusyError) res.headers.set('Retry-After', String(e.retryAfterSeconds));
    if (!isNavigation(req)) return res;
    return (await backToReport(slug, id, e, res)) ?? res;
  }
}

let warnedNoPublicOrigin = false;

/** The report page for a refused download opened as a page, absolute on the public origin; null keeps the JSON answer `res`. */
async function backToReport(slug: string, id: string, e: unknown, res: Response): Promise<Response | null> {
  const reason: ReportRefusal | null = e instanceof WorkingReportBusyError ? 'report_busy'
    : res.status === 422 ? 'part' : res.status === 404 ? 'not_found' : res.status >= 500 ? 'internal_error' : null;
  if (reason === null) return null;
  const reference = reason === 'internal_error' ? String(((await res.clone().json()) as { reference?: unknown }).reference ?? '') : undefined;
  const location = reportRefusalLocation(slug, id, reason, reference);
  if (location === null) return null;
  try {
    const redirect = NextResponse.redirect(new URL(location, publicOrigin()), 303);
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  } catch (err) {
    // publicOrigin() throws when neither AUTH_URL nor NEXTAUTH_URL is set. The redirect is a convenience: the person still gets the
    // JSON answer, as the export route does. Said once per process, so the missing setting is visible.
    if (!warnedNoPublicOrigin) {
      warnedNoPublicOrigin = true;
      console.warn('working report: no public origin, so a refused download answers JSON instead of going back to the report page', err);
    }
    return null;
  }
}
