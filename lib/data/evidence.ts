import { createHash } from 'node:crypto';
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
 * No cap, deliberately: a cap suits a BROWSING endpoint, where a silently truncated tail is an acceptable
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

/** The one test of "unattached": no decision version and no mitigation version names the item (FR-EVD-06). */
const NOT_LINKED = { decisionLinks: { none: {} }, mitigationLinks: { none: {} } } as const;

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
      ...NOT_LINKED,
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
 * hash value is returned, and the line names the account that was downloading.
 * An unattached file is readable by id like any evidence item of the organisation (the Why of FR-EVD-06): hiding it from
 * screens keeps it out of the record, not secret from the team. The name is the stored one, or `evidence-<id>` when the operator erased it.
 */
export async function readEvidenceForDownload(
  ctx: OrgContext, actor: Actor, evidenceId: string,
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
    integrityFailure(ctx, actor, evidenceId, 'missing_blob');
  }
  // A view of the blob's own memory, not a copy: up to 10 MiB per download.
  const content = found.content as Uint8Array;
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (createHash('sha256').update(bytes).digest('hex') !== found.row.sha256) integrityFailure(ctx, actor, evidenceId, 'hash_mismatch');
  return { bytes, fileName: found.row.filename ?? `evidence-${evidenceId}` };
}

/** Logs the failure (ids, who was downloading, and the reason only) and throws the 500 the route answers through toResponse. */
function integrityFailure(ctx: OrgContext, actor: Actor, evidenceId: string, reason: 'missing_blob' | 'hash_mismatch'): never {
  logSecurityEvent('EVIDENCE_INTEGRITY_FAILURE', 'critical', { userId: actor.userId, details: { orgId: ctx.orgId, evidenceId, reason } });
  throw new AppError(500, 'integrity_failure');
}
