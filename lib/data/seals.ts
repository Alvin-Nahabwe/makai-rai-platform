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
import { SEAL_SOURCE_SQL, checkSealRows, manifestFromRows, manifestIds, trustedManifest, type SealSourceRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
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

/** A seal row as `SEAL_VIEW_SELECT` reads it: what a `SealView` is made of, the stored bytes included. */
export type SealViewRow = {
  id: string; stageReviewId: string; sealNumber: number; fingerprint: string; sealedById: string; sealedByRole: SealView['sealedByRole'];
  sealedAt: Date; manifest: Uint8Array; contentVersion: { semver: string };
};

/** `SealView` of seal rows, `bytesMatch` checked against the stored bytes on every read (NFR-INT-05, gap G015). */
export async function sealViews(tx: TenantTx, rows: SealViewRow[]): Promise<SealView[]> {
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
 * The kinds `SEAL_CHECK_FAILED` carries (NFR-OBS-01, ids only): a `SealCheckResult` kind other than `valid`, or
 * `unreadable` for a check that could not finish; the documents page also writes `summary_failed` and `bytes_mismatch`. Its emissions: `checkSeal` for every result that is not valid and for
 * a check that throws; `sealsIncludingRows` once per process for each seal it leaves out.
 */
type SealCheckFailedKind = Exclude<SealCheckResult['kind'], 'valid'> | 'unreadable';
function logSealCheckFailed(sealId: string, kind: SealCheckFailedKind, level: 'warn' | 'error' = 'warn'): void {
  logSecurityEvent('SEAL_CHECK_FAILED', level, { details: { sealId, kind } });
}

/**
 * Checks a stored seal (FR-REV-06; the check of "Check this seal", UX-19). In one REPEATABLE READ snapshot and a UTC
 * session it reads the seal and every query of the contract's `SEAL_SOURCE_SQL` with this organisation as `$1` (the
 * same queries OPS-HOST's restore test runs); the transaction then commits, and `checkSealRows` runs on what it read,
 * so no connection is held through the work (CR-2). `checkSealRows` compares the bytes with the row they came from
 * (RE-3) and reads a tombstone it cannot use as standing for nothing, so each seal is checked on its own. A result
 * other than valid logs one `SEAL_CHECK_FAILED`; so does a check that cannot finish, which is then thrown on.
 */
export async function checkSeal(ctx: OrgContext, sealId: string): Promise<SealCheckResult> {
  const { seal, read } = await withOrg(ctx, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
    const found = await tx.seal.findFirst({ where: { id: sealId }, select: { id: true, manifest: true, fingerprint: true } });
    if (found === null) throw new NotFoundError();
    const rows: Record<string, unknown[]> = {};
    for (const [table, sql] of Object.entries(SEAL_SOURCE_SQL)) {
      rows[table] = (await tx.$queryRawUnsafe<{ r: unknown }[]>(sql, ctx.orgId)).map((x) => x.r);
    }
    return { seal: found, read: rows };
  }, { isolationLevel: 'RepeatableRead' });

  const { tombstones, ...rows } = read;
  let result: SealCheckResult;
  try {
    result = checkSealRows({
      sealId: seal.id, manifestBytes: seal.manifest, fingerprint: seal.fingerprint,
      rows: rows as unknown as SealSourceRows, tombstones: tombstones as TombstoneRow[],
    });
  } catch (e) {
    // A check that cannot finish is a failed check too: logged, then thrown on (the route answers 500).
    logSealCheckFailed(sealId, 'unreadable', 'error');
    throw e;
  }
  if (result.kind !== 'valid') logSealCheckFailed(sealId, result.kind);
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
 * The latest seal of each review (the one `listSeals` gives first, the highest `sealNumber`), as stored, keyed by review
 * id; a review with no seal has no entry. Two statements whatever the number of reviews or seals (NFR-PERF-04, FIX-12):
 * the latest seal ids, then those rows, so no other seal's bytes are read. Inside the caller's transaction, so row-level
 * security scopes it to the organisation.
 */
export async function latestSealRows(tx: TenantTx, reviewIds: readonly string[]): Promise<Map<string, SealViewRow>> {
  const ids = [...new Set(reviewIds)];
  if (ids.length === 0) return new Map();
  const latest = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ON ("stageReviewId") "id" FROM "seals"
    WHERE "orgId" = NULLIF(current_setting('app.current_org_id', true), '') AND "stageReviewId" = ANY (${ids}::text[])
    ORDER BY "stageReviewId", "sealNumber" DESC`;
  if (latest.length === 0) return new Map();
  const rows = await tx.seal.findMany({ where: { id: { in: latest.map((r) => r.id) } }, select: SEAL_VIEW_SELECT });
  return new Map(rows.map((r) => [r.stageReviewId, r]));
}

/**
 * For each row id, the seals whose manifest names it (FR-REV-05; contract `sealsIncludingRows`). One query finds
 * the seals of this organisation (row-level security) whose stored bytes contain one of the ids; a seal is kept for
 * an id only when `manifestIds` of its parsed manifest holds that id, so an id that appears inside another id or a
 * digest is not counted (obligation A11). A seal whose stored bytes do not vouch for it (`trustedManifest`: a
 * fingerprint that no longer matches, bytes copied from another seal, bytes that are no manifest) is left out, since
 * what it names cannot be shown as sealed (NFR-INT-05). It is logged once per process, so a page that looks it up on
 * every view does not log it every time, and it never makes the lookup throw (CR-3).
 *
 * `rowIds`: decision version, finding, mitigation version or accepted risk ids.
 */
/** The seals `sealsIncludingRows` has logged as untrusted in this process. */
const loggedUntrusted = new Set<string>();

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
    // The same gate as the check (trustedManifest): a damaged seal, or one holding another seal's bytes, or bytes that
    // are no manifest, vouches for nothing. It is left out, never thrown, and logged once per process (RE-4).
    const gate = trustedManifest({ sealId: s.id, manifestBytes: s.manifest, fingerprint: s.fingerprint });
    if (gate.kind !== 'trusted') {
      if (!loggedUntrusted.has(s.id)) {
        loggedUntrusted.add(s.id);
        logSealCheckFailed(s.id, gate.kind);
      }
      continue;
    }
    const manifest = gate.manifest;
    const named = manifestIds(manifest);
    const all = new Set([...named.decisionVersions, ...named.findings, ...named.mitigationVersions, ...named.acceptedRisks, ...named.findingEvents, ...named.evidence]);
    const ref: SealRef = { sealId: s.id, sealNumber: s.sealNumber, reviewId: s.stageReviewId, reviewName: stageReviewName(s.stage as Stage, s.numberInStage) };
    for (const id of ids) if (all.has(id)) out.set(id, [...(out.get(id) ?? []), ref]);
  }
  return out;
}
