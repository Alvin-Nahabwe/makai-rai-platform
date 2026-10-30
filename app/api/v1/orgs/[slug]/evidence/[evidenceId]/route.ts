import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { NotFoundError, withOrg } from '@/lib/data/tenant';
import { toResponse } from '@/lib/http/toResponse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * silent-failure-hunter finding (task-7-report.md): every logSecurityEvent
 * call in this file runs AFTER the outcome it reports has already been
 * decided (for DELETE's 'ok' case, after the delete has already committed).
 * The audit log is a side channel, not the decision path -- if it were to
 * throw (logSecurityEvent's own JSON.stringify has no failure mode for the
 * plain-string `details` this file ever passes it, but a future change to
 * either side could introduce one), that must never invert an
 * already-succeeded mutation into a client-visible failure. Scoped to this
 * file rather than changed in lib/security-logger.ts itself, which every
 * other already-reviewed route also calls and whose behaviour for THEM is
 * out of this task's reach to assess.
 */
function logSafely(...args: Parameters<typeof logSecurityEvent>): void {
  try {
    logSecurityEvent(...args);
  } catch (e) {
    console.error('evidence route: logSecurityEvent failed', e);
  }
}

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
 * The path that serves attacker-influenced bytes back out. Org-scoped but
 * NOT nested under an assessment (the URL carries [slug] and [evidenceId]
 * only) -- the parent assessment is reached via the evidence row's own
 * `assessmentId`, not cross-checked against anything in the URL, because
 * there is nothing in the URL naming it. There is no O-6-style "does X
 * belong to the assessment named in the URL" confinement to write here: the
 * evidenceId itself IS the target, and the composite FK
 * `evidence(orgId, assessmentId) -> assessments(orgId, id)` already
 * guarantees the assessment RLS resolves for this row shares this row's
 * org, so no separate manual cross-org check on the assessment lookup is
 * needed -- RLS re-confirms it anyway, as defense in depth, not as the
 * primary control.
 *
 * Fresh C1 senior-security findings for THIS task (task-7-report.md),
 * distinct from Task 6's upload threat table:
 *
 *  - Content-Length is derived from the bytes actually about to be written
 *    to the response (`blob.content.byteLength`), never from the
 *    separately-stored `evidence.byteSize` column. Nothing in the schema
 *    ties the two together after the write (no UPDATE grant exists on
 *    either table, so they cannot drift by the app's own hand, but a
 *    corrupted `byteSize` column alone -- distinct from corrupted content --
 *    would otherwise send a Content-Length that does not match the body,
 *    which the O-9 hash check would not catch, since it only ever inspects
 *    `blob.content`).
 *  - A missing `blob` relation (an evidence row with no corresponding
 *    evidence_blobs row -- a data-integrity anomaly distinct from a hash
 *    mismatch, since there is nothing to hash) fails closed the same way,
 *    logged with its own `reason` so the two cases stay distinguishable
 *    server-side, rather than crashing on `row.blob.content`.
 *  - The integrity-failure response body is a fixed, generic string. The
 *    computed and stored hash values, and which specific check fired, are
 *    logged server-side only -- not returned to the client, which already
 *    has read access to this evidence by virtue of reaching this branch at
 *    all, but gains nothing legitimate from being told exactly HOW the
 *    corruption was detected.
 *  - `crypto.timingSafeEqual` is deliberately NOT used for the hash
 *    comparison: `sha256` is a public integrity checksum of content the
 *    caller already has read access to (they can compute their own hash of
 *    the very bytes this endpoint would serve), not a secret or a MAC. A
 *    timing side-channel here would leak nothing an authorized reader could
 *    not already compute directly.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; evidenceId: string }> },
) {
  const { slug, evidenceId } = await params;
  try {
    // requireOrgContextWithIdentity, not the bare requireOrgContext every
    // other read-only GET in this route family uses -- `identity.userId` is
    // needed to attribute an EVIDENCE_INTEGRITY_FAILURE log entry to who was
    // downloading when corruption was discovered.
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'record:read');

    // Fetch inside withOrg, then let the transaction close before hashing --
    // same reasoning as the PDF report route's fetch-then-render split
    // (reports/[id]/pdf/route.ts): holding one of only 10 pooled connections
    // for a CPU-bound operation (here, hashing up to MAX_BYTES of content) is
    // an avoidable hold under concurrent load.
    const row = await withOrg(ctx, (tx) =>
      tx.evidence.findUnique({ where: { id: evidenceId }, include: { blob: true } }),
    );
    // RLS scopes evidenceId to this org; nonexistent and belongs-to-another-org
    // are indistinguishable here, both null -- ADR-0001, matches every sibling
    // route's single-resource GET.
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (!row.blob) {
      logSafely('EVIDENCE_INTEGRITY_FAILURE', 'critical', {
        userId: identity.userId,
        details: { evidenceId, reason: 'missing_blob' },
      });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    // O-9: recompute over the ACTUAL stored bytes and compare before a
    // single byte reaches the response. On mismatch the only ways to get
    // here are corruption or tampering -- fail loudly and log it; never
    // serve the bytes, never silently re-derive/repair the stored hash.
    const computedHash = createHash('sha256').update(row.blob.content).digest('hex');
    if (computedHash !== row.sha256) {
      logSafely('EVIDENCE_INTEGRITY_FAILURE', 'critical', {
        userId: identity.userId,
        details: { evidenceId, reason: 'hash_mismatch' },
      });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    return new Response(row.blob.content, {
      headers: {
        // Fixed string. Never `row.mimeType` (the value Task 6's inspect()
        // determined from magic bytes at upload time -- legitimate for
        // storage provenance, never for what this endpoint tells a browser
        // to DO with the bytes) and never any client-supplied claim.
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': buildContentDisposition(row.filename),
        // No nosniff header here: nginx sets it on every response, once
        // (docker/nginx/default.conf), and a second copy from the app would
        // reach the browser as a duplicate.
        // From the bytes actually being written to the response body, not
        // the separately-stored `row.byteSize` column -- see the module
        // doc's first fresh finding.
        'Content-Length': String(row.blob.content.byteLength),
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
