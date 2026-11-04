import { open } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { releaseTeamExport, writeTeamExport } from '@/lib/data/export';
import { AppError } from '@/lib/http/errors';
import { exportRefusalLocation } from '@/lib/http/exportRefusal';
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

/** The file as a stream that calls `release` once, however the stream ends. */
async function fileStream(path: string, release: () => Promise<void>): Promise<ReadableStream<Uint8Array>> {
  const handle = await open(path, 'r');
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    try {
      await handle.close();
    } finally {
      await release();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = new Uint8Array(CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
        if (bytesRead === 0) {
          await finish(); // before close, so the reader's last read returns after the file is gone
          controller.close();
        } else {
          controller.enqueue(chunk.subarray(0, bytesRead));
        }
      } catch (e) {
        try {
          await finish();
        } finally {
          controller.error(e);
        }
      }
    },
    async cancel() {
      await finish();
    },
  });
}

/** S-20's page for a refused navigation, absolute on the public origin; null keeps the JSON 429. */
function refusalRedirect(slug: string, projectId: string | null): NextResponse | null {
  const location = exportRefusalLocation(slug, projectId, 'export_busy');
  if (location === null) return null;
  try {
    return NextResponse.redirect(new URL(location, publicOrigin()), 303);
  } catch {
    // publicOrigin() throws when neither AUTH_URL nor NEXTAUTH_URL is set. The redirect is a convenience:
    // the person still gets the refusal as the JSON 429, as the proxy does for rate_limited (contract Routes row 20).
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const projectId = req.nextUrl.searchParams.get('projectId') || null;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'team:export');
    const written = await writeTeamExport(ctx, { userId: identity.userId, role: ctx.role }, { projectId });
    let body: ReadableStream<Uint8Array>;
    try {
      body = await fileStream(written.path, () => releaseTeamExport(written.path));
    } catch (e) {
      await releaseTeamExport(written.path);
      throw e;
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${written.fileName}"`,
        'Content-Length': String(written.bytes),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'export_busy' && req.headers.get('sec-fetch-mode') === 'navigate') {
      const redirect = refusalRedirect(slug, projectId);
      if (redirect !== null) return redirect;
    }
    return toResponse(e);
  }
}
