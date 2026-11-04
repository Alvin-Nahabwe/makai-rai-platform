import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, WriteOutcome } from '@/types/record';
import type { SealRequest, SealView } from '@/types/api';
import type { SealCheckResult, SealRef } from '@/types/seal';
import { ConflictError } from '@/lib/http/errors';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { isSerializationFailure, uniqueViolationIndex } from '@/lib/data/pgErrors';
import { userRefs } from '@/lib/data/views';
import { resolveRunningContentVersion } from '@/lib/data/framework';
import { loadContent } from '@/lib/content/loader';
import { logSecurityEvent } from '@/lib/security-logger';
import { canonicalManifestBytes, fingerprintHex } from '@/lib/integrity/canonical.mjs';
import { SEAL_SOURCE_SQL, checkSealRows, manifestFromRows, manifestIds, type SealSourceRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';
import { stageReviewName } from '@/lib/seal/reviewName';
import type { Stage } from '@/types/record';

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
  const attempt = () => idempotentWrite<SealView>(ctx, {
    table: 'seals', requestId: a.requestId, digest, actorUserId: actor.userId, isolationLevel: 'RepeatableRead',
    write: (tx) => writeSeal(tx, ctx, actor, a, digest),
    replay: async (tx, rowId) => sealViews(tx, [await tx.seal.findUniqueOrThrow({ where: { id: rowId }, select: SEAL_VIEW_SELECT })]).then((v) => v[0]),
  });
  let out: WriteOutcome<SealView>;
  try {
    try {
      out = await attempt();
    } catch (e) {
      // 40001: the project row changed after this transaction's snapshot (an archive, a rename), so its FOR SHARE lock
      // failed. One more attempt reads a new snapshot: an archive then answers 409 project_archived, a rename seals.
      // The second attempt looks the request id up again, so a replay stays a replay. Once only: a second 40001 is thrown on.
      if (!isSerializationFailure(e)) throw e;
      out = await attempt();
    }
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

/**
 * Checks a stored seal (FR-REV-06; the check of "Check this seal", UX-19): in one REPEATABLE READ snapshot and a
 * UTC session, every query of the contract's `SEAL_SOURCE_SQL` with this organisation as `$1` (the same queries
 * OPS-HOST's restore test runs), then `checkSealRows`. Each seal is checked on its own call, and the pure check reads
 * a tombstone it cannot use as standing for nothing, so one bad row elsewhere in the organisation does not stop it.
 * A result that reads valid for bytes naming another seal (copied, with their fingerprint, into this row) is a
 * mismatch at `seal.id` (RE-3). Any result other than valid logs one `SEAL_CHECK_FAILED`, ids only.
 */
export async function checkSeal(ctx: OrgContext, sealId: string): Promise<SealCheckResult> {
  const result = await withOrg(ctx, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
    const seal = await tx.seal.findFirst({ where: { id: sealId }, select: { id: true, manifest: true, fingerprint: true } });
    if (seal === null) throw new NotFoundError();
    const read: Record<string, unknown[]> = {};
    for (const [table, sql] of Object.entries(SEAL_SOURCE_SQL)) {
      read[table] = (await tx.$queryRawUnsafe<{ r: unknown }[]>(sql, ctx.orgId)).map((x) => x.r);
    }
    const { tombstones, ...rows } = read;
    let checked: SealCheckResult;
    try {
      checked = checkSealRows({
        manifestBytes: seal.manifest, fingerprint: seal.fingerprint,
        rows: rows as unknown as SealSourceRows, tombstones: tombstones as TombstoneRow[],
      });
    } catch (e) {
      // A check that cannot finish is a failed check too: logged, then thrown on (the route answers 500).
      logSecurityEvent('SEAL_CHECK_FAILED', 'error', { details: { sealId, kind: 'error' } });
      throw e;
    }
    // checkSealRows parsed these bytes to read valid, so they are a manifest with a seal id.
    if (checked.kind === 'valid' && (JSON.parse(Buffer.from(seal.manifest).toString('utf8')) as { seal: { id: unknown } }).seal.id !== seal.id) {
      return { kind: 'mismatch', firstDifference: 'seal.id' } satisfies SealCheckResult;
    }
    return checked;
  }, { isolationLevel: 'RepeatableRead' });
  if (result.kind !== 'valid') logSecurityEvent('SEAL_CHECK_FAILED', 'warn', { details: { sealId, kind: result.kind } });
  return result;
}

/** Route 14's scope: the seal belongs to the review and the review to the project, else 404 (obligation A3). */
export async function assertSealOfReview(ctx: OrgContext, projectId: string, reviewId: string, sealId: string): Promise<void> {
  const found = await withOrg(ctx, (tx) => tx.seal.findFirst({
    where: { id: sealId, stageReviewId: reviewId, stageReview: { projectId } }, select: { id: true },
  }));
  if (found === null) throw new NotFoundError();
}

/** A review's seals, newest first (W-7 note 2), each with `bytesMatch` checked on this read (NFR-INT-05, gap G015). */
export async function listSeals(ctx: OrgContext, reviewId: string): Promise<SealView[]> {
  return withOrg(ctx, async (tx) => sealViews(tx, await tx.seal.findMany({
    where: { stageReviewId: reviewId }, orderBy: { sealNumber: 'desc' }, select: SEAL_VIEW_SELECT,
  })));
}

/**
 * For each row id, the seals whose manifest names it (FR-REV-05; contract `sealsIncludingRows`). One query finds
 * the seals of this organisation (row-level security) whose stored bytes contain one of the ids; a seal is kept for
 * an id only when `manifestIds` of its parsed manifest holds that id, so an id that appears inside another id or a
 * digest is not counted (obligation A11). A seal whose bytes no longer match its fingerprint, or whose manifest names
 * another seal (bytes copied with their fingerprint, RE-3), is left out, since what it names cannot be shown as
 * sealed (NFR-INT-05); each such seal logs one SEAL_CHECK_FAILED, so it is not silently absent.
 *
 * `rowIds`: decision version, finding, mitigation version or accepted risk ids.
 */
export async function sealsIncludingRows(ctx: OrgContext, rowIds: readonly string[]): Promise<Map<string, SealRef[]>> {
  const ids = [...new Set(rowIds)];
  const out = new Map<string, SealRef[]>();
  if (ids.length === 0) return out;
  const seals = await withOrg(ctx, (tx) => tx.$queryRaw<Array<{
    id: string; sealNumber: number; stageReviewId: string; manifest: Uint8Array; fingerprint: string; stage: string; numberInStage: number;
  }>>`
    SELECT s."id", s."sealNumber", s."stageReviewId", s."manifest", s."fingerprint", r."stage", r."numberInStage"
    FROM seals s JOIN stage_reviews r ON r."orgId" = s."orgId" AND r."id" = s."stageReviewId"
    WHERE EXISTS (SELECT 1 FROM unnest(${ids}::text[]) AS x(id) WHERE position(convert_to(x.id, 'UTF8') in s."manifest") > 0)
    ORDER BY r."stage", r."numberInStage", s."sealNumber"`);
  for (const s of seals) {
    // A seal that is damaged, or holds bytes copied from another seal (RE-3), vouches for nothing; it is logged, not shown.
    if (fingerprintHex(s.manifest) !== s.fingerprint) {
      logSecurityEvent('SEAL_CHECK_FAILED', 'warn', { details: { sealId: s.id, kind: 'fingerprint_mismatch' } });
      continue;
    }
    const manifest = JSON.parse(Buffer.from(s.manifest).toString('utf8'));
    if (manifest?.seal?.id !== s.id) {
      logSecurityEvent('SEAL_CHECK_FAILED', 'warn', { details: { sealId: s.id, kind: 'mismatch' } });
      continue;
    }
    const named = manifestIds(manifest);
    const all = new Set([...named.decisionVersions, ...named.findings, ...named.mitigationVersions, ...named.acceptedRisks, ...named.findingEvents, ...named.evidence]);
    const ref: SealRef = { sealId: s.id, sealNumber: s.sealNumber, reviewId: s.stageReviewId, reviewName: stageReviewName(s.stage as Stage, s.numberInStage) };
    for (const id of ids) if (all.has(id)) out.set(id, [...(out.get(id) ?? []), ref]);
  }
  return out;
}
