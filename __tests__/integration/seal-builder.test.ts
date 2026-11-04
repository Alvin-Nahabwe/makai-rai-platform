import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { sealStageReview } from '@/lib/data/seals';
import { withOrg } from '@/lib/data/tenant';
import { stageSnapshotIds, manifestIds } from '@/lib/seal/ids';
import { saltedDigestHex } from '@/lib/integrity/canonical.mjs';
import { SEAL_SOURCE_SQL, checkSealRows, type SealSourceRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
import type { SealManifestV1 } from '@/types/seal';
import type { Stage } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { MARKER_PATTERN, markerFor, markerText } from '../helpers/markers';
import {
  addDecision, addEvidence, addProject, addStageReview, buildOrg, ctxFor, type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';

/**
 * The seal builder (FR-REV-03, SRS 5.4): the server builds the manifest from its own snapshot of the stage, stores
 * the bytes, their fingerprint, the sealer and the database time in one transaction. Records come from K0a's
 * fixture builder (contract "Fixture setup, not another unit's service"); free text carries markers (NFR-PRIV-03).
 */
let fx: OrgFixture;
let p: { id: string };
let fv: { contentVersionId: string; contentHash: string };

const dec = (questionId: string, f: { contentVersionId: string }, evidenceIds: string[] = []): FixtureDecision =>
  ({ stage: 'pre-processing', questionId, contentVersionId: f.contentVersionId, declaredDate: '2026-10-20', evidenceIds });
const actorOf = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
const entry = (m: SealManifestV1, q: string) => m.decisions.find((d) => d.question === q) as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const digestOf = () => createHash('sha256').update(randomUUID()).digest('hex');

async function sealReview(reviewId: string, role: OrgRole = 'reviewer') {
  return sealStageReview(ctxFor(fx, role), actorOf(role), { requestId: randomUUID(), projectId: p.id, reviewId }, digestOf());
}
async function sealBytes(reviewId: string): Promise<Buffer> {
  const out = await sealReview(reviewId);
  return Buffer.from((await testDb.seal.findUniqueOrThrow({ where: { id: out.value.id } })).manifest);
}
async function sealAndParse(stage: Stage): Promise<SealManifestV1> {
  const r = await addStageReview(fx, p.id, { stage });
  return JSON.parse((await sealBytes(r.id)).toString('utf8'));
}
async function saltOf(table: 'stage_reviews' | 'decision_versions', id: string, column: string): Promise<Buffer> {
  const [row] = await testDb.$queryRawUnsafe<{ s: Buffer }[]>(`SELECT "${column}" AS s FROM ${table} WHERE id = $1`, id);
  return Buffer.from(row.s);
}
/** The organisation's rows as the check reads them: SEAL_SOURCE_SQL in a UTC session. */
async function orgRows(): Promise<{ rows: SealSourceRows; tombstones: TombstoneRow[] }> {
  const all = await testDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
    return Object.fromEntries(await Promise.all(Object.entries(SEAL_SOURCE_SQL)
      .map(async ([t, sql]) => [t, (await tx.$queryRawUnsafe<{ r: unknown }[]>(sql, fx.org.id)).map((x) => x.r)])));
  });
  const { tombstones, ...rows } = all;
  return { rows: rows as unknown as SealSourceRows, tombstones: tombstones as TombstoneRow[] };
}

beforeEach(async () => {
  await resetDb();
  fv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
});

describe('sealStageReview (lib/data/seals.ts)', () => {
  it('FR-REV-03: three decisions and one file seal with the stored fingerprint over the stored bytes, the three version ids and the file hash', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: Buffer.from('ZZ file') });
    const ids = [await addDecision(fx, p.id, dec('Q-PP-01', fv, [ev.id])), await addDecision(fx, p.id, dec('Q-PP-02', fv)), await addDecision(fx, p.id, dec('Q-PP-03', fv))].map((d) => d.id);
    const r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const out = await sealReview(r.id);
    expect(out.replayed).toBe(false);
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: out.value.id } });
    expect(row.fingerprint).toBe(createHash('sha256').update(row.manifest).digest('hex'));
    expect(row.format).toBe('makrai.seal/1');
    const m = JSON.parse(Buffer.from(row.manifest).toString('utf8'));
    expect(m.decisions.filter((d: { id?: string }) => d.id).map((d: { id: string }) => d.id).sort()).toEqual(ids.sort());
    expect(entry(m, 'Q-PP-01').evidence[0].sha256).toBe(ev.sha256);
    expect(out.value).toMatchObject({ id: row.id, reviewId: r.id, sealNumber: 1, fingerprint: row.fingerprint, sealedByRole: 'reviewer', contentSemver: '0.0.1-fixture', bytesMatch: true });
    expect(out.value.sealedBy.userId).toBe(fx.members.reviewer.userId);
  });

  it('FR-REV-03 FR-CNT-07: decisions answered on two content versions each carry their own content', async () => {
    const f1 = await useFixtureContent('0.0.1-fixture'); await addDecision(fx, p.id, dec('Q-PP-01', f1));
    const f2 = await useFixtureContent('0.0.2-fixture'); await addDecision(fx, p.id, dec('Q-PP-02', f2));
    const m = await sealAndParse('pre-processing');
    expect(entry(m, 'Q-PP-01').content).toEqual({ semver: '0.0.1-fixture', contentHash: f1.contentHash });
    expect(entry(m, 'Q-PP-02').content).toEqual({ semver: '0.0.2-fixture', contentHash: f2.contentHash });
    expect(m.content).toEqual({ semver: '0.0.2-fixture', contentHash: f2.contentHash });
  });

  it('FR-REV-03 FR-REV-01 (R-67) NFR-PRIV-03: the Prepared for note and every reason enter only as salted digests', async () => {
    const note = markerFor('preparedFor', 1);
    const v = await addDecision(fx, p.id, dec('Q-PP-01', fv));   // reason text from markerText
    const r = await addStageReview(fx, p.id, { stage: 'pre-processing', preparedFor: note });
    const bytes = await sealBytes(r.id);
    expect(bytes.toString('utf8')).not.toMatch(MARKER_PATTERN);
    const m = JSON.parse(bytes.toString('utf8'));
    expect(m.seal.preparedFor).toEqual({ d: saltedDigestHex(await saltOf('stage_reviews', r.id, 'preparedForSalt'), 'preparedFor', note) });
    const [{ reason }] = await testDb.$queryRaw<{ reason: string }[]>`SELECT reason FROM decision_versions WHERE id = ${v.id}`;
    expect(entry(m, 'Q-PP-01').reason).toEqual({ d: saltedDigestHex(await saltOf('decision_versions', v.id, 'reasonSalt'), 'reason', reason) });
  });

  it('FR-REV-05 (helper): stageSnapshotIds equals manifestIds of a seal taken now', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01', fv));
    await addDecision(fx, p.id, { ...dec('Q-PP-GATE-SENSITIVE', fv), scopeAnswer: 'no' });
    const m = await sealAndParse('pre-processing');
    expect(await withOrg(ctxFor(fx, 'viewer'), (tx) => stageSnapshotIds(tx, p.id, 'pre-processing'))).toEqual(manifestIds(m));
  });

  it('FR-REV-03 FR-REV-08 (ruling b): a reason erased before sealing is sealed with its tombstone digest, and the check reads one field erased', async () => {
    const v = await addDecision(fx, p.id, dec('Q-PP-01', fv));
    const [{ reason }] = await testDb.$queryRaw<{ reason: string }[]>`SELECT reason FROM decision_versions WHERE id = ${v.id}`;
    const salt = await saltOf('decision_versions', v.id, 'reasonSalt');
    await testDb.$executeRawUnsafe(`SELECT erase_text_field($1, 'decision_versions', $2, 'reason', 'ER-1', 'INSTR-1')`, fx.org.id, v.id);
    const r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const out = await sealReview(r.id);
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: out.value.id } });
    expect(entry(JSON.parse(Buffer.from(row.manifest).toString('utf8')), 'Q-PP-01').reason).toEqual({ d: saltedDigestHex(salt, 'reason', reason) });
    const { rows, tombstones } = await orgRows();
    expect(checkSealRows({ manifestBytes: row.manifest, fingerprint: row.fingerprint, rows, tombstones })).toMatchObject({ kind: 'valid', erasedFields: 1 });
  });
});
