import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireOrgContextWithIdentity } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
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
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'evidence:read');

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

type DeleteOutcome =
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'ok' };

/**
 * O-24 (delete half): evidence attached to a completed assessment is
 * immutable. `evidence:delete` is granted to owner/admin/assessor only
 * (lib/authz/policy.ts) -- reviewer/viewer never reach the body of this
 * handler at all, refused by `requireOrgContextWithIdentity` itself.
 *
 * Fresh C1 finding, not named by the task brief: the "is the assessment
 * completed" read and the eventual `completeAssessment` write
 * (lib/data/assessments.ts) are two DIFFERENT transactions that can be
 * in flight at the same time. Under Postgres's default READ COMMITTED
 * isolation, a plain `SELECT status FROM assessments` here does not block
 * a concurrent `UPDATE assessments SET status = 'completed'` from
 * `completeAssessment`'s own transaction, and vice versa -- so a delete
 * that reads 'in_progress' a moment before a completion commits could
 * still remove evidence from what becomes, a fraction of a second later, a
 * completed assessment. That is exactly the invariant O-24 exists to
 * guarantee an auditor can trust (design spec §5.1: "an auditor can trust
 * that a completed assessment's evidence set is what was actually
 * reviewed"), and this codebase has already shipped one bug of this exact
 * shape (D-130, the assessment-autosave/completion race).
 *
 * `SELECT ... FOR UPDATE` closes it: it takes the SAME row-level lock an
 * `UPDATE` on that row takes, so this read and `completeAssessment`'s write
 * serialize on the assessments row regardless of which one FIRST reaches
 * the lock. No change to `completeAssessment` is required; Postgres's row
 * locking is symmetric between `FOR UPDATE` and a live `UPDATE` on the same
 * row.
 *
 * Two claims here were each verified live, independently, rather than left
 * asserted (task-7-report.md, coordinator fix round 1 -- the second was
 * originally left as a claim from memory next to a first claim that had
 * already been given this treatment, which is exactly the inconsistency
 * AGENTS.md §5 warns an unverified claim can hide inside an otherwise
 * well-evidenced one):
 *
 *   1. `FOR UPDATE` runs cleanly under row security, and a concurrent
 *      `UPDATE` on a locked row genuinely blocks until the lock is
 *      released -- confirmed with a raw two-connection probe against this
 *      schema's actual RLS-protected `assessments` table, under the
 *      restricted `makrai_app` role, before this fix was written.
 *   2. A `FOR UPDATE` blocked behind another transaction's still-open
 *      `UPDATE` re-reads the POST-COMMIT row version once unblocked (here,
 *      'completed'), not the pre-transaction snapshot it would have seen
 *      had it never been forced to wait -- confirmed with a second raw
 *      probe, this time COMMITTING the competing transaction instead of
 *      rolling it back, before the corresponding test below existed.
 *
 * Both are now also proven against the real exported `DELETE` handler
 * below, by this file's own matched pair of concurrency tests -- one
 * competing transaction rolls back (the delete proceeds), the other
 * commits (the delete is refused, and the evidence is NOT lost). The
 * commit direction is the one where a wrong implementation is dangerous: a
 * `FOR UPDATE` that failed to re-read post-commit would let this delete
 * see the stale 'in_progress' snapshot and remove evidence from what is,
 * by the time it commits, a completed assessment -- silently, with no
 * trace an auditor could find afterward. Non-vacuity proven for that
 * specific direction by temporarily removing `FOR UPDATE`: the delete no
 * longer blocked at all, and the evidence was actually deleted (see the
 * report for the exact output, including the `EVIDENCE_DELETED` log line
 * firing on the vulnerable path).
 *
 * `$queryRaw`'s tagged-template form parameterizes `${row.assessmentId}` --
 * no `$queryRawUnsafe`, no string interpolation, so this introduces no SQL
 * injection surface regardless of what `evidenceId` looks like.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; evidenceId: string }> },
) {
  const { slug, evidenceId } = await params;
  try {
    const { identity, ctx } = await requireOrgContextWithIdentity(slug, 'evidence:delete');

    const outcome = await withOrg(ctx, async (tx): Promise<DeleteOutcome> => {
      const row = await tx.evidence.findUnique({
        where: { id: evidenceId },
        select: { assessmentId: true },
      });
      if (!row) return { kind: 'not_found' };

      // silent-failure-hunter finding (task-7-report.md): FOR UPDATE with
      // no lock_timeout waits indefinitely if some OTHER transaction is
      // stuck holding this row's lock -- bounded today only by Prisma's own
      // interactive-transaction timeout, an "unpinned" default this
      // codebase already tracks generally (D-065), not a deliberate bound
      // for this specific query. SET LOCAL reverts automatically at the end
      // of this transaction, same discipline withOrg's own SET LOCAL
      // app.current_org_id already uses (lib/data/tenant.ts) -- shorter
      // than Prisma's ~5s default so a genuine lock collision surfaces a
      // clear, attributable Postgres "canceling statement due to lock
      // timeout" error rather than an ambiguous transaction-timeout one.
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM "assessments" WHERE id = ${row.assessmentId} FOR UPDATE`;
      const assessment = locked[0];
      // The composite FK (evidence.orgId, evidence.assessmentId) ->
      // assessments(orgId, id) guarantees this row exists and shares this
      // evidence row's org; RLS re-confirms it. Not believed reachable --
      // handled anyway, fail closed, rather than trusting that belief
      // (same posture Task 6's upload route takes for its own analogous
      // "not believed reachable" branch).
      if (!assessment) return { kind: 'not_found' };

      if (assessment.status === 'completed') return { kind: 'conflict' };

      // The blob follows via ON DELETE CASCADE on evidence_blobs' composite
      // FK to evidence(orgId, id) -- verified live by this file's own
      // "deletes evidence... and its blob with it" test, not assumed from
      // the schema comment.
      await tx.evidence.delete({ where: { id: evidenceId } });
      return { kind: 'ok' };
    });

    switch (outcome.kind) {
      case 'not_found':
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'conflict':
        logSafely('INPUT_VALIDATION_FAILURE', 'warn', {
          userId: identity.userId,
          details: { route: 'evidence:delete', evidenceId, reason: 'assessment_completed' },
        });
        return NextResponse.json(
          { error: 'Evidence on a completed assessment cannot be deleted' },
          { status: 409 },
        );
      case 'ok':
        logSafely('EVIDENCE_DELETED', 'warn', {
          userId: identity.userId,
          details: { evidenceId },
        });
        return NextResponse.json({ success: true });
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`evidence delete: unhandled outcome ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    return toResponse(e);
  }
}
