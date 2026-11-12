import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { openTeamExport, releaseTeamExport, writeTeamExport } from '@/lib/data/export';
import { AppError } from '@/lib/http/errors';
import { exportRefusalLocation } from '@/lib/http/exportRefusal';
import { isNavigation, navigationRefusal } from '@/lib/http/navigationRefusal';
import { toResponse } from '@/lib/http/toResponse';
import { publicOrigin } from '@/lib/publicOrigin';

/**
 * Route 20 (00-contract.md, Routes row 20; SRS 6.3, ADR-C7): GET the team export of the
 * organisation, or of one project with `?projectId=<id>`, for an owner or admin (`team:export`).
 *
 * The ZIP is written first, from one snapshot, to a temporary file (`writeTeamExport`); the
 * transaction is closed before the first byte is sent, and the file is then streamed, so a slow
 * client holds no database connection. The stream releases the file and its slot exactly once:
 * at its end, when the client cancels, or when a read fails.
 *
 * A third export while two are written answers 429 `export_busy`. When that refusal meets a
 * browser navigation (S-20's download is a plain link), it answers 303 back to S-20 of the same
 * scope with `?refused=export_busy`, at the public origin, never the request's (behind nginx the
 * request carries the container's host, lib/publicOrigin.ts). The hourly limit's refusal
 * (`rate_limited`) is the proxy's and never reaches this handler.
 */

const CHUNK_BYTES = 64 * 1024;

/**
 * The file as a stream that calls `release` once, however it ends: at the end of the file (before
 * the reader's last read returns), on cancel, on a failed read, or when `signal` aborts because the
 * client left (Next does not always cancel a body whose client has gone). A failed close or release
 * is logged here and never passed to the reader: a download already delivered stays delivered, and
 * the directory left behind is swept after 24 hours.
 */
async function fileStream(path: string, release: () => Promise<void>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const handle = await openTeamExport(path);
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    for (const step of [() => handle.close(), release]) {
      try {
        await step();
      } catch (e) {
        console.error('team export: releasing the temporary file failed', e);
      }
    }
  };
  signal.addEventListener('abort', () => void finish(), { once: true });
  // An abort does not replay to a listener added after it: a client that left during the open is released here (C4 SF-4).
  if (signal.aborted) void finish();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.error(new Error('team export: the client left; the export was released'));
        return;
      }
      try {
        const chunk = new Uint8Array(CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
        if (bytesRead === 0) {
          await finish();
          controller.close();
        } else {
          controller.enqueue(chunk.subarray(0, bytesRead));
        }
      } catch (e) {
        if (!finished) console.error('team export: reading the temporary file failed', e);
        await finish();
        controller.error(e);
      }
    },
    async cancel() {
      await finish();
    },
  });
}

let warnedNoPublicOrigin = false;

/** S-20's page for a refused navigation, absolute on the public origin; null keeps the JSON 429. */
function refusalRedirect(slug: string, projectId: string | null): NextResponse | null {
  const location = exportRefusalLocation(slug, projectId, 'export_busy');
  if (location === null) return null;
  try {
    return NextResponse.redirect(new URL(location, publicOrigin()), 303);
  } catch (e) {
    // publicOrigin() throws when neither AUTH_URL nor NEXTAUTH_URL is set (or one is not a URL). The redirect is a
    // convenience: the person still gets the refusal as the JSON 429, as the proxy does for rate_limited (contract
    // Routes row 20). Said once per process, so a missing setting is visible without a line per refusal.
    if (!warnedNoPublicOrigin) {
      warnedNoPublicOrigin = true;
      console.warn('team export: no public origin, so a refused download answers JSON instead of going back to S-20', e);
    }
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  // Next answers HEAD with this handler and never reads a HEAD body, so a HEAD that wrote an export would hold
  // its slot for six hours. A HEAD gets no export.
  if (req.method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const { slug } = await params;
  const projectId = req.nextUrl.searchParams.get('projectId') || null;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'team:export');
    const written = await writeTeamExport(ctx, { userId: identity.userId, role: ctx.role }, { projectId });
    try {
      if (req.signal.aborted) {
        // The client left while the export was written (up to ten minutes): nobody will read it.
        await releaseTeamExport(written.path);
        return new Response(null, { status: 499 });
      }
      const body = await fileStream(written.path, () => releaseTeamExport(written.path), req.signal);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${written.fileName}"`,
          'Content-Length': String(written.bytes),
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      // Opening the file failed: release it, and answer with the open's error, not a failed release's.
      await releaseTeamExport(written.path).catch((cleanup: unknown) => {
        console.error('team export: releasing the temporary file failed', cleanup);
      });
      throw e;
    }
  } catch (e) {
    if (e instanceof AppError && e.code === 'export_busy' && isNavigation(req)) {
      const redirect = refusalRedirect(slug, projectId);
      if (redirect !== null) return redirect;
    }
    return navigationRefusal(req, e) ?? toResponse(e);
  }
}
