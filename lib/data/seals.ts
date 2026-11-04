/* eslint-disable @typescript-eslint/no-unused-vars -- the remaining stub bodies keep the contract's parameter names; Task 6 fills them. */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NotFoundError, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, WriteOutcome } from '@/types/record';
import type { SealRequest, SealView } from '@/types/api';
import type { SealCheckResult, SealRef } from '@/types/seal';
import { ConflictError, NotImplementedError } from '@/lib/http/errors';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { uniqueViolationIndex } from '@/lib/data/pgErrors';
import { userRefs } from '@/lib/data/views';
import { resolveRunningContentVersion } from '@/lib/data/framework';
import { loadContent } from '@/lib/content/loader';
import { logSecurityEvent } from '@/lib/security-logger';
import { canonicalManifestBytes, fingerprintHex } from '@/lib/integrity/canonical.mjs';
import { SEAL_SOURCE_SQL, manifestFromRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';

/** Seal builder, seal check and seal lists (FR-REV-03, 04, 06). */

const FORMAT = 'makrai.seal/1';
/** K0a's unique index on (orgId, stageReviewId, sealNumber): a concurrent seal of the same review took the number (SRS 5.3 item 3). */
const SEAL_NUMBER_INDEX = 'seals_orgId_stageReviewId_sealNumber_key';

const SEAL_VIEW_SELECT = {
  id: true, stageReviewId: true, sealNumber: true, fingerprint: true, sealedById: true, sealedByRole: true, sealedAt: true,
  manifest: true, contentVersion: { select: { semver: true } },
} satisfies Prisma.SealSelect;

/** `SealView` of seal rows, `bytesMatch` checked against the stored bytes on every read (NFR-INT-05, gap G015). */
async function sealViews(tx: TenantTx, rows: Array<{
  id: string; stageReviewId: string; sealNumber: number; fingerprint: string; sealedById: string; sealedByRole: SealView['sealedByRole'];
  sealedAt: Date; manifest: Uint8Array; contentVersion: { semver: string };
}>): Promise<SealView[]> {
  const refs = await userRefs(tx, rows.map((r) => r.sealedById));
  return rows.map((r) => {
    const sealedBy = refs.get(r.sealedById);
    // Accounts are scrubbed, never deleted (FR-EXP-03): a sealer with no account row is a defect, not a blank name.
    if (sealedBy === undefined) throw new Error(`seals: no account for the sealer of seal ${r.id}`);
    return {
      id: r.id, reviewId: r.stageReviewId, sealNumber: r.sealNumber, fingerprint: r.fingerprint, sealedBy, sealedByRole: r.sealedByRole,
      sealedAt: r.sealedAt.toISOString(), contentSemver: r.contentVersion.semver, bytesMatch: fingerprintHex(r.manifest) === r.fingerprint,
    };
  });
}

/**
 * Builds and stores the seal of a stage review (FR-REV-03; SRS 5.3 items 3, 5, 9; 5.4), inside `idempotentWrite`'s
 * one REPEATABLE READ transaction: every read below sees one snapshot (NFR-INT-10). Nothing in the manifest comes
 * from the client: the rows are the server's, the sealer and role the session's, the time the database's
 * (`transaction_timestamp()`, the value K0a's trigger writes into `sealedAt`, contract Data model Seal, G012).
 */
async function writeSeal(tx: TenantTx, ctx: OrgContext, actor: Actor, a: { projectId: string; reviewId: string; requestId: string }, digest: string): Promise<SealView> {
  await assertProjectWritable(tx, a.projectId);
  const review = await tx.stageReview.findFirst({ where: { id: a.reviewId, projectId: a.projectId }, select: { id: true, stage: true } });
  if (review === null) throw new NotFoundError();
  const stage = review.stage as Parameters<typeof readStageRows>[2];

  const [{ at }] = await tx.$queryRaw<{ at: Date }[]>`SELECT date_trunc('milliseconds', transaction_timestamp()) AS at`;
  const running = await resolveRunningContentVersion(tx);
  const rows = await readStageRows(tx, a.projectId, stage);
  // Tombstones of the same snapshot: a field erased before sealing is sealed with its tombstone digest (ruling b).
  const tombstones = (await tx.$queryRawUnsafe<{ r: TombstoneRow }[]>(SEAL_SOURCE_SQL.tombstones, ctx.orgId)).map((x) => x.r);
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT (coalesce(max("sealNumber"), 0) + 1)::int AS n FROM seals WHERE "orgId" = ${ctx.orgId} AND "stageReviewId" = ${review.id}`;

  const sealId = randomUUID();
  const header = {
    id: sealId, orgId: ctx.orgId, stageReviewId: review.id, sealNumber: n, contentVersionId: running.contentVersionId,
    sealedById: actor.userId, sealedByRole: actor.role, sealedAt: at.toISOString(),
  };
  const plan = stagePlan(rows, { stage, content: loadContent(running.semver) });
  const bytes = canonicalManifestBytes(manifestFromRows({ ...rows, seals: [header] }, { sealId, ...plan }, tombstones));
  const created = await tx.seal.create({
    data: {
      id: sealId, orgId: ctx.orgId, stageReviewId: review.id, sealNumber: n, format: FORMAT, contentVersionId: running.contentVersionId,
      manifest: Uint8Array.from(bytes), fingerprint: fingerprintHex(bytes), sealedById: actor.userId, sealedByRole: actor.role,
      requestId: a.requestId, requestDigest: digest,
    },
    select: SEAL_VIEW_SELECT,
  });
  // The trigger, not this code, writes sealedAt; a seal whose row and manifest disagree on it must not be stored.
  if (created.sealedAt.getTime() !== at.getTime()) {
    throw new Error(`seals: the stored sealedAt ${created.sealedAt.toISOString()} is not the manifest's ${at.toISOString()}`);
  }
  return (await sealViews(tx, [created]))[0];
}

export async function sealStageReview(
  ctx: OrgContext, actor: Actor, a: SealRequest & { projectId: string; reviewId: string }, digest: string,
): Promise<WriteOutcome<SealView>> {
  let out: WriteOutcome<SealView>;
  try {
    out = await idempotentWrite<SealView>(ctx, {
      table: 'seals', requestId: a.requestId, digest, actorUserId: actor.userId, isolationLevel: 'RepeatableRead',
      write: (tx) => writeSeal(tx, ctx, actor, a, digest),
      replay: async (tx, rowId) => sealViews(tx, [await tx.seal.findUniqueOrThrow({ where: { id: rowId }, select: SEAL_VIEW_SELECT })]).then((v) => v[0]),
    });
  } catch (e) {
    // Only the seal-number index means "another seal of this review took the number"; anything else goes on as it is.
    if (uniqueViolationIndex(e) === SEAL_NUMBER_INDEX) throw new ConflictError('number_taken');
    throw e;
  }
  if (!out.replayed) {
    const v = out.value;
    logSecurityEvent('SEAL_CREATED', 'info', { details: { sealId: v.id, fingerprint: v.fingerprint, sealNumber: v.sealNumber, sealedAt: v.sealedAt } });
  }
  return out;
}

// CONTRACT_STUB: REV-a
export async function checkSeal(ctx: OrgContext, sealId: string): Promise<SealCheckResult> {
  throw new NotImplementedError('REV-a');
}

// CONTRACT_STUB: REV-a
export async function listSeals(ctx: OrgContext, reviewId: string): Promise<SealView[]> {
  return [];
}

/** `rowIds`: decision version, finding, mitigation version or accepted risk ids. */
// CONTRACT_STUB: REV-a
export async function sealsIncludingRows(
  ctx: OrgContext, rowIds: readonly string[],
): Promise<Map<string, SealRef[]>> {
  return new Map();
}
