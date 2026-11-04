import { createHash } from 'node:crypto';
import type { EvidenceLevel } from '@prisma/client';
import { NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { EvidenceItemView } from '@/types/api';
import type { Actor, WriteOutcome } from '@/types/record';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { evidenceViews } from '@/lib/data/views';
import { AppError, ErasedError } from '@/lib/http/errors';
import { inspect } from '@/lib/evidence/inspect';
import { assertStorageAvailable } from '@/lib/evidence/storageCap';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Task 11 (O-12). Every evidence row THIS user uploaded, within ONE org's
 * `withOrg` scope — the caller (`app/api/users/me/export/route.ts`) calls
 * this once per org returned by `orgContextsForUser`
 * (lib/auth/context.ts) and flattens the results. Metadata only, matching
 * O-12's own deliberate choice not to
 * carry bytes through the personal-data export (see that route's module doc
 * and task-11-report.md for the full reasoning) — `select` names every
 * column a caller might reasonably want EXCEPT `frameworkVersionId` (an
 * internal pinning/provenance detail, not something about what the user
 * themselves did) and never touches `evidence_blobs` at all.
 *
 * No `EVIDENCE_LIST_LIMIT`-style cap, deliberately: that limit exists for a
 * BROWSING endpoint, where a silently truncated tail is an acceptable
 * trade-off for a bounded response. An EXPORT that silently dropped rows
 * past some cap would itself be the exact "false statement about what the
 * system holds" O-12 exists to prevent — the obligation this function
 * serves forbids the mitigation `listEvidenceForAssessment` uses.
 */
export function listEvidenceUploadedByUser(userId: string, tx: TenantTx) {
  return tx.evidence.findMany({
    where: { uploadedById: userId },
    select: {
      id: true,
      orgId: true,
      assessmentId: true,
      questionId: true,
      remediationItemId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      sha256: true,
      uploadedAt: true,
    },
    orderBy: { uploadedAt: 'desc' },
  });
}

/**
 * O-20 (task-8-report.md): `RemediationItem.evidenceLevel` is not a stored
 * column — it is this computation, run fresh on every read. `artifact_uploaded`
 * iff at least one `evidence` row exists for the item; `self_attestation`
 * otherwise. There is no third state and no way for a request body to name
 * one directly (the PATCH route no longer accepts the field at all).
 */
export function deriveEvidenceLevel(evidenceCount: number): EvidenceLevel {
  return evidenceCount > 0 ? 'artifact_uploaded' : 'self_attestation';
}

/**
 * The Prisma `include` fragment every RemediationItem read-path adds so
 * `withDerivedEvidenceLevel` below has what it needs: a per-item COUNT of
 * its `evidence` rows, not the rows themselves. Deliberately `_count`, not
 * the brief's own suggested `evidence: { select: { id: true } }` — a count
 * is a bounded aggregate regardless of how much evidence one item
 * eventually accumulates, where an unbounded relation load is exactly the
 * shape `EVIDENCE_LIST_LIMIT` above already exists to guard against on the
 * sibling listing endpoint. Reusable at any nesting depth: pass it directly
 * as a RemediationItem query's own `include` (remediation GET/PATCH), or as
 * the value of a nested `{ include: EVIDENCE_COUNT_INCLUDE }` wherever
 * `remediationItems` is included from a parent (assessment/project detail).
 */
export const EVIDENCE_COUNT_INCLUDE = { _count: { select: { evidence: true } } } as const;

type WithEvidenceCount = { _count: { evidence: number } };

/**
 * Maps a RemediationItem queried with `EVIDENCE_COUNT_INCLUDE` to its
 * client-facing shape: `_count` (a query artifact that was never meant to
 * reach a client — it would leak an evidence COUNT through a field no
 * client contract names) is replaced by the `evidenceLevel` it derives.
 * Every one of the four JSON-API routes that serialize a RemediationItem
 * (remediation GET/PATCH, assessment-detail GET, project-detail GET) routes
 * through this, so the same item cannot show a different evidenceLevel
 * depending on which of THOSE FOUR served it.
 *
 * That invariant does NOT extend to every RemediationItem read in the
 * codebase — `app/(authenticated)/orgs/[slug]/projects/[id]/page.tsx`
 * queries `remediationItems` directly via its own Prisma call, outside
 * this helper, and is not wired to it (D-164: not a live defect today,
 * because that page never reads `.evidenceLevel` at all — but it is a real
 * fifth site the "four places" phrasing above could otherwise be read to
 * cover and does not). Wire any FUTURE direct RemediationItem query
 * through `EVIDENCE_COUNT_INCLUDE` + this function the moment it needs
 * `evidenceLevel`, rather than deriving inline.
 */
export function withDerivedEvidenceLevel<T extends WithEvidenceCount>(
  item: T,
): Omit<T, '_count'> & { evidenceLevel: EvidenceLevel } {
  const { _count, ...rest } = item;
  return { ...rest, evidenceLevel: deriveEvidenceLevel(_count.evidence) };
}

/**
 * FR-EVD-06, IC-4: v0.6.0 evidence of the project (of the organisation, when `projectId` is null) that no decision
 * version and no mitigation version names, of any kind, ordered by upload time then id. `uploadedById` limits the
 * list to one uploader: a page passes the signed-in user's id, because an unattached upload shows only in its
 * uploader's draft (SRS line 829); only the team export passes `null` (every uploader). Opens no transaction, so the
 * export can call it inside its own single snapshot (NFR-INT-10). The third parameter is required, so no caller can
 * forget it.
 */
export async function unattachedEvidenceIn(
  tx: TenantTx, projectId: string | null, uploadedById: string | null,
): Promise<EvidenceItemView[]> {
  const rows = await tx.evidence.findMany({
    where: {
      projectId: projectId ?? { not: null },
      ...(uploadedById === null ? {} : { uploadedById }),
      decisionLinks: { none: {} },
      mitigationLinks: { none: {} },
    },
    select: { id: true },
    orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
  });
  const views = await evidenceViews(tx, rows.map((r) => r.id));
  return rows.map((r) => {
    const view = views.get(r.id);
    if (view === undefined) throw new TypeError(`evidence ${r.id} has no view`);
    return view;
  });
}

/** `unattachedEvidenceIn` in a transaction of its own. */
export function unattachedEvidence(
  ctx: OrgContext, projectId: string | null, uploadedById: string | null,
): Promise<EvidenceItemView[]> {
  return withOrg(ctx, (tx) => unattachedEvidenceIn(tx, projectId, uploadedById));
}

/** One evidence row's view, read inside the transaction that wrote or found it. */
async function viewOfEvidence(tx: TenantTx, id: string): Promise<EvidenceItemView> {
  const view = (await evidenceViews(tx, [id])).get(id);
  if (view === undefined) throw new TypeError(`evidence ${id} has no view`);
  return view;
}

/** NFR-OBS-01: one line per new upload, after the commit, ids only (NFR-PRIV-03; contract "Security event names"). */
function logUploaded(ctx: OrgContext, actor: Actor, projectId: string, view: EvidenceItemView): void {
  logSecurityEvent('EVIDENCE_UPLOADED', 'info', {
    userId: actor.userId, details: { orgId: ctx.orgId, projectId, evidenceId: view.id, kind: view.kind },
  });
}

/**
 * FR-EVD-01, FR-EVD-02: stores an uploaded file for a project, retry-safe by request id and digest. The type comes
 * from the bytes alone (`inspect`); the declared type is never read. The evidence row and its blob are written in one
 * transaction, after the project is writable and the storage caps hold (NFR-REL-09). The stored name is the name as
 * given. Nothing links the item to a decision yet: until a save does, it is an unattached upload (FR-EVD-06).
 */
export async function createFileEvidence(
  ctx: OrgContext, actor: Actor,
  a: { projectId: string; fileName: string; bytes: Buffer; requestId: string }, digest: string,
): Promise<WriteOutcome<EvidenceItemView>> {
  const inspected = inspect(a.bytes);
  if (!inspected.ok) {
    throw inspected.reason === 'too large'
      ? new AppError(413, 'file_too_large')
      : new AppError(400, 'unsupported_file_type');
  }
  const sha256 = createHash('sha256').update(a.bytes).digest('hex');
  const outcome = await idempotentWrite(ctx, {
    table: 'evidence', requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      await assertStorageAvailable(tx, { userId: actor.userId, addBytes: a.bytes.byteLength });
      const row = await tx.evidence.create({
        data: {
          orgId: ctx.orgId, projectId: a.projectId, kind: 'file', filename: a.fileName, mimeType: inspected.mimeType,
          byteSize: a.bytes.byteLength, sha256, uploadedById: actor.userId, requestId: a.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      // Prisma's Bytes type is Uint8Array<ArrayBuffer>; the copy is a plain, non-shared buffer.
      await tx.evidenceBlob.create({ data: { evidenceId: row.id, orgId: ctx.orgId, content: new Uint8Array(a.bytes) } });
      return viewOfEvidence(tx, row.id);
    },
    replay: (tx, rowId) => viewOfEvidence(tx, rowId),
  });
  if (!outcome.replayed) logUploaded(ctx, actor, a.projectId, outcome.value);
  return outcome;
}

/**
 * FR-EVD-01, FR-EVD-03: stores a link for a project, retry-safe like a file. A link stores no bytes, so no storage
 * check applies, and nothing here fetches it (FR-EVD-03).
 */
export async function createLinkEvidence(
  ctx: OrgContext, actor: Actor,
  a: { projectId: string; url: string; label: string | null; requestId: string }, digest: string,
): Promise<WriteOutcome<EvidenceItemView>> {
  const outcome = await idempotentWrite(ctx, {
    table: 'evidence', requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      const row = await tx.evidence.create({
        data: {
          orgId: ctx.orgId, projectId: a.projectId, kind: 'link', url: a.url, label: a.label,
          uploadedById: actor.userId, requestId: a.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      return viewOfEvidence(tx, row.id);
    },
    replay: (tx, rowId) => viewOfEvidence(tx, rowId),
  });
  if (!outcome.replayed) logUploaded(ctx, actor, a.projectId, outcome.value);
  return outcome;
}

/**
 * FR-EVD-02, FR-EVD-05, NFR-INT-06: the bytes of one stored file and the name to save them under. The row and blob
 * are read inside `withOrg`, which then closes, before the hash is computed (a pooled connection is not held for
 * CPU-bound work). A missing row, one of another organisation (row-level security makes them the same) and a link
 * all throw NotFoundError, so a foreign id and a missing id answer alike (finding SEC-03). Bytes erased by the
 * operator (no blob, a tombstone) throw ErasedError with the date. No blob and no tombstone, or bytes that do not
 * hash to the stored value, log EVIDENCE_INTEGRITY_FAILURE and throw `integrity_failure`: no byte is served and no
 * hash value is returned. The name is the stored one, or `evidence-<id>` when the operator erased it.
 */
export async function readEvidenceForDownload(
  ctx: OrgContext, evidenceId: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  const found = await withOrg(ctx, async (tx) => {
    const row = await tx.evidence.findUnique({ where: { id: evidenceId }, include: { blob: true } });
    if (row === null || row.kind !== 'file') return null;
    if (row.blob === null) {
      const erased = (await evidenceViews(tx, [evidenceId])).get(evidenceId)?.erased ?? null;
      return { row, content: null, erasedOn: erased?.erasedOn ?? null };
    }
    return { row, content: row.blob.content, erasedOn: null };
  });
  if (found === null) throw new NotFoundError();
  if (found.content === null) {
    if (found.erasedOn !== null) throw new ErasedError(found.erasedOn);
    integrityFailure(ctx, evidenceId, 'missing_blob');
  }
  const bytes = Buffer.from(found.content as Uint8Array);
  if (createHash('sha256').update(bytes).digest('hex') !== found.row.sha256) integrityFailure(ctx, evidenceId, 'hash_mismatch');
  return { bytes, fileName: found.row.filename ?? `evidence-${evidenceId}` };
}

/** Logs the failure (ids and the reason only) and throws the 500 the route answers through toResponse. */
function integrityFailure(ctx: OrgContext, evidenceId: string, reason: 'missing_blob' | 'hash_mismatch'): never {
  logSecurityEvent('EVIDENCE_INTEGRITY_FAILURE', 'critical', { details: { orgId: ctx.orgId, evidenceId, reason } });
  throw new AppError(500, 'integrity_failure');
}
