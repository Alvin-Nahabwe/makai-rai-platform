import { createHash } from 'node:crypto';
import questionBank from '@/data/questionBank.json';
import type { EvidenceLevel } from '@prisma/client';
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { EvidenceItemView } from '@/types/api';
import type { Actor, WriteOutcome } from '@/types/record';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { evidenceViews } from '@/lib/data/views';
import { AppError } from '@/lib/http/errors';
import { inspect } from '@/lib/evidence/inspect';
import { assertStorageAvailable } from '@/lib/evidence/storageCap';
import { logSecurityEvent } from '@/lib/security-logger';

export type CreateEvidenceInput = {
  assessmentId: string;
  frameworkVersionId: string;
  questionId: string | null;
  remediationItemId: string | null;
  filename: string;
  mimeType: string;
  content: Buffer;
  uploadedById: string;
  orgId: string;
};

/**
 * Metadata and blob are written in ONE transaction: a metadata row with no
 * bytes is a broken evidence claim, and bytes with no metadata are
 * unreachable. The caller is already inside withOrg, so `tx` is that
 * transaction -- do not open a second one.
 *
 * O-23: `existing` is a idempotency check keyed on the SAME four columns as
 * `evidence_dedup_key` (`assessmentId, sha256, questionId, remediationItemId`,
 * `UNIQUE ... NULLS NOT DISTINCT`) -- a retry after a dropped response
 * returns the row already created rather than raising a constraint error or
 * creating a second one.
 */
export async function createEvidence(input: CreateEvidenceInput, tx: TenantTx) {
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const existing = await tx.evidence.findFirst({
    where: {
      assessmentId: input.assessmentId,
      sha256,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
    },
  });
  if (existing) return existing;

  const row = await tx.evidence.create({
    data: {
      orgId: input.orgId,
      assessmentId: input.assessmentId,
      frameworkVersionId: input.frameworkVersionId,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteLength,
      sha256,
      uploadedById: input.uploadedById,
    },
  });
  await tx.evidenceBlob.create({
    // Prisma's generated `Bytes` type is `Uint8Array<ArrayBuffer>` specifically,
    // not the wider `Buffer<ArrayBufferLike>` (Buffer's `.buffer` can in
    // principle be a SharedArrayBuffer) -- `new Uint8Array(...)` copies into a
    // freshly allocated, non-shared ArrayBuffer, satisfying that type exactly.
    data: { evidenceId: row.id, orgId: input.orgId, content: new Uint8Array(input.content) },
  });
  return row;
}

/**
 * A stopgap ceiling, not real pagination (D-155 tracks building that,
 * before Task 10's attach UI puts a page on top of this query). Bounds the
 * worst case -- an assessment that has accumulated an unbounded number of
 * evidence rows returning ALL of them on every GET, found by fix round 1's
 * review -- without claiming to solve browsing a large evidence set well.
 */
const EVIDENCE_LIST_LIMIT = 1000;

/**
 * Metadata only -- never selects the blob. The tables are split precisely so
 * this cannot accidentally drag bytes; keep it that way. Capped at
 * `EVIDENCE_LIST_LIMIT` (see its own comment) -- ordered newest-first, so a
 * capped result is still the MOST RECENT evidence, the most useful default
 * when the cap actually binds.
 */
export function listEvidenceForAssessment(assessmentId: string, tx: TenantTx) {
  return tx.evidence.findMany({
    where: { assessmentId },
    orderBy: { uploadedAt: 'desc' },
    take: EVIDENCE_LIST_LIMIT,
  });
}

/**
 * Task 11 (O-12). Every evidence row THIS user uploaded, within ONE org's
 * `withOrg` scope — the caller (`app/api/users/me/export/route.ts`) calls
 * this once per org returned by `orgContextsForUser`
 * (lib/auth/context.ts) and flattens the results. Metadata only, matching
 * `listEvidenceForAssessment` above and O-12's own deliberate choice not to
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
 * The full set of question ids in the CURRENTLY deployed question bank,
 * flattened from `data/questionBank.json`'s `stages -> modules -> questions`
 * nesting. Computed once at module load from a STATIC import (matches
 * `lib/data/framework.ts#readCurrentContentVersion`'s own reasoning: no
 * synchronous disk I/O inside an open `withOrg` transaction, which holds one
 * of only 10 pooled connections) -- generated from the file rather than
 * hand-maintained, per AGENTS.md §3 ("where a list must be complete,
 * generate it rather than writing it").
 */
type QuestionBankShape = {
  stages: Record<string, { modules: Array<{ questions: Array<{ id: string }> }> }>;
};

const ALL_QUESTION_IDS: ReadonlySet<string> = new Set(
  Object.values((questionBank as QuestionBankShape).stages).flatMap((stage) =>
    stage.modules.flatMap((mod) => mod.questions.map((q) => q.id)),
  ),
);

/**
 * O-22: does `questionId` name a real question in the question bank?
 *
 * Safe to read as "the PINNED version's question bank" only once the
 * caller has already confirmed `resolveFramework(assessmentId, tx).matches
 * === true` for this assessment -- `data/questionBank.json` is one of the
 * four files `lib/framework/bundleHash.ts#BUNDLE_FILES` hashes, so a
 * `matches` result of `true` already proves the deployed file IS the
 * content this assessment pinned. Verifying that is the ROUTE's ordering
 * responsibility (it runs this check only after the drift check), not this
 * function's -- a pure lookup has no assessment to check drift against.
 *
 * O-2's CHECK constraint proves exactly one attach target is present; this
 * proves the questionId target, when present, actually exists -- a
 * different claim neither the CHECK nor `num_nonnulls` establishes.
 */
export function questionExistsInBank(questionId: string): boolean {
  return ALL_QUESTION_IDS.has(questionId);
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

/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; EVD replaces them. */
/**
 * Evidence uploaded to a project (or, with a null `projectId`, to none) and not yet attached to a decision
 * version, read for `uploadedById` only: FR-EVD-06 shows an unattached upload in its uploader's draft alone,
 * and only the team export passes `null` (every uploader). A list read, so the stub returns the empty list.
 */
// CONTRACT_STUB: EVD
export async function unattachedEvidence(
  ctx: OrgContext, projectId: string | null, uploadedById: string | null,
): Promise<EvidenceItemView[]> {
  return [];
}

/** `unattachedEvidence` with no transaction of its own, for the team export's single snapshot (NFR-INT-10). */
// CONTRACT_STUB: EVD
export async function unattachedEvidenceIn(
  tx: TenantTx, projectId: string | null, uploadedById: string | null,
): Promise<EvidenceItemView[]> {
  return [];
}
/* eslint-enable @typescript-eslint/no-unused-vars */

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
