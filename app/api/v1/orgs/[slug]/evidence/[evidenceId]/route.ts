import { NextRequest } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { readEvidenceForDownload } from '@/lib/data/evidence';
import { NotFoundError } from '@/lib/data/tenant';
import { stripBidiControls } from '@/lib/evidence/format';
import { toResponse } from '@/lib/http/toResponse';

/**
 * RFC 6266: ASCII fallback with the two characters that break out of the
 * quoted-string form ('"', '\') and every non-printable-ASCII byte
 * (including CR/LF) stripped, plus a filename* extended form for the real
 * value. encodeURIComponent removes CR and LF by construction (they are not
 * in its unreserved set, so both are percent-encoded), which is what makes
 * the extended form immune to the same attack the ASCII fallback's regex
 * stops by a different mechanism. Never interpolate the raw filename into a
 * header under any circumstance.
 *
 * Extracted as its own pure, exported function (rather than left inline in
 * GET below) specifically so it is unit-testable against an input a real
 * `row.filename` can never actually contain: a lone (unpaired) UTF-16
 * surrogate makes `encodeURIComponent` throw a `URIError` (silent-failure-
 * hunter finding, task-7-report.md), but Postgres's UTF8 encoding cannot
 * represent an unpaired surrogate at all, and Node's own string-to-UTF8
 * boundary silently substitutes U+FFFD for one before a write ever reaches
 * the database (verified live) -- so a value that would trigger the throw
 * cannot survive the real create-then-read round trip an integration test
 * would otherwise have to use, and a test going through that round trip
 * would be vacuous by construction. Calling this function directly with a
 * raw in-memory string sidesteps that and exercises the actual throw path.
 * The `catch` below is kept as defense in depth against some OTHER future
 * write path (a raw-SQL migration, a different driver) having different
 * encoding behaviour, not because this one is known reachable today.
 */
export function buildContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  let encoded: string;
  try {
    encoded = encodeURIComponent(filename);
  } catch {
    // ascii is guaranteed pure printable ASCII (0x20-0x7E) by construction
    // above, so encodeURIComponent(ascii) cannot itself throw here.
    encoded = encodeURIComponent(ascii);
  }
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Contract route row 4: serves one stored file back, only as a checked attachment (FR-EVD-02, NFR-SEC-10). The
 * path that serves attacker-influenced bytes: the type is fixed (`application/octet-stream`), never the stored one;
 * the name goes into the header only through `buildContentDisposition`, with bidi controls stripped (E14); the
 * service checks the SHA-256 on every download and refuses with 500 `integrity_failure` before a byte is served
 * (NFR-INT-06), answers 410 once the operator erased the bytes, and 404 alike for a missing, foreign or link item
 * (SEC-03). Every refusal is an error that `toResponse` maps, so each carries its code (and a reference from 500 up).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; evidenceId: string }> },
) {
  const { slug, evidenceId } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'record:read');
    // The service reads, checks the hash and answers every refusal (404, 410, 500 integrity_failure) as an error
    // that toResponse maps, so no inline answer is left here.
    const { bytes, fileName } = await readEvidenceForDownload(ctx, { userId: identity.userId, role: ctx.role }, evidenceId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        // Fixed string. Never the stored mimeType and never any client-supplied claim.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(stripBidiControls(fileName)),
        // No nosniff header here: nginx sets it on every response, once (docker/nginx/default.conf).
        // From the bytes actually written to the body, not the stored byteSize column.
        'Content-Length': String(bytes.byteLength),
      },
    });
  } catch (e) {
    return toResponse(e);
  }
}

/**
 * FR-AUTHZ-02: evidence is append-only from v0.6.0, so this route no longer deletes anything. The method
 * stays an explicit handler because Next answers 405 for a method a route file does not export
 * (node_modules/next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js:16-28), and the
 * requirement is a 404 (`REMOVED_METHODS` in lib/authz/routeActions.ts). It answers before any session or
 * database read, so every caller gets the same body.
 */
export async function DELETE(
  _req: NextRequest,
  _ctx: { params: Promise<{ slug: string; evidenceId: string }> },
): Promise<Response> {
  return toResponse(new NotFoundError());
}
