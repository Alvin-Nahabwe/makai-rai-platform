import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { checkSeal, listSeals, sealStageReview, sealsIncludingRows } from '@/lib/data/seals';
import { SEAL_SOURCE_SQL, SEAL_SOURCE_TABLES, checkSealRows, type SealSourceRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerText } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addDecision, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/** Contract route row 14 and the seal check (FR-REV-04, FR-REV-06, NFR-INT-05). */

// One test makes the pure check throw once, to see that checkSeal still logs the failure.
const broken = vi.hoisted(() => ({ next: false }));
vi.mock('@/lib/integrity/sealCheck.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/integrity/sealCheck.mjs')>();
  return {
    ...real,
    checkSealRows: (...args: Parameters<typeof real.checkSealRows>) => {
      if (broken.next) { broken.next = false; throw new TypeError('sealCheck: a row of decision_versions has no column "enteredByRole"'); }
      return real.checkSealRows(...args);
    },
  };
});
const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/[sealId]/check/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };
let r: { id: string };
let r2: { id: string };
let v1: string;
let fv: { contentVersionId: string };

async function sealOf(org: OrgFixture, projectId: string, reviewId: string, role: OrgRole = 'reviewer') {
  const out = await sealStageReview(ctxFor(org, role), { userId: org.members[role].userId, role },
    { requestId: randomUUID(), projectId, reviewId }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  return out.value;
}

/** Runs `fn` with the table's own triggers disabled (as `makrai`), and re-enables each with its earlier mode. */
async function withTriggersDisabled(table: string, fn: () => Promise<unknown>): Promise<void> {
  const triggers = await testDb.$queryRawUnsafe<{ name: string; mode: string }[]>(
    `SELECT tgname AS name, tgenabled::text AS mode FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, table);
  await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    for (const t of triggers) {
      const how = t.mode === 'A' ? 'ENABLE ALWAYS' : t.mode === 'R' ? 'ENABLE REPLICA' : t.mode === 'D' ? 'DISABLE' : 'ENABLE';
      await testDb.$executeRawUnsafe(`ALTER TABLE "${table}" ${how} TRIGGER "${t.name}"`);
    }
  }
}
const asOperator = (sql: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
  await tx.$executeRawUnsafe(sql);
});
const runAsRole = (role: string, sql: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${fx.org.id}', true)`);
  await tx.$executeRawUnsafe(sql);
});
async function getCheck(projectId: string, reviewId: string, sealId: string, role: OrgRole): Promise<Response> {
  sessionAs(fx.members[role].userId);
  return callRoute(ROUTE, 'GET', { slug: fx.org.slug, params: { id: projectId, reviewId, sealId } });
}

beforeEach(async () => {
  broken.next = false;
  await resetDb();
  fv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx);
  v1 = (await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' })).id;
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  r2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('the seal check (checkSeal, listSeals, sealsIncludingRows, route 14)', () => {
  it('FR-REV-06: a reason changed by a superuser with triggers disabled reads mismatch at decisions[Q-PP-01].reason', async () => {
    const s = await sealOf(fx, p.id, r.id);
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toEqual({ kind: 'valid', erasedFields: 0, erasedFiles: 0, erasedOn: null, clockWarnings: [] });
    await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET reason = 'changed' WHERE id = ${v1}`);
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].reason' });
  });

  it('NFR-INT-05: a seal whose stored bytes were altered reads fingerprint_mismatch and bytesMatch false', async () => {
    const s = await sealOf(fx, p.id, r.id);
    expect((await listSeals(ctxFor(fx, 'viewer'), r.id))[0]).toMatchObject({ id: s.id, bytesMatch: true });
    await withTriggersDisabled('seals', () => testDb.$executeRaw`UPDATE seals SET manifest = manifest || '\x20'::bytea WHERE id = ${s.id}`);
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toEqual({ kind: 'fingerprint_mismatch' });
    expect((await listSeals(ctxFor(fx, 'viewer'), r.id))[0]).toMatchObject({ id: s.id, bytesMatch: false, fingerprint: s.fingerprint });
  });

  it('FR-REV-06 (RE-3): bytes and fingerprint copied from another seal read mismatch at seal.id, not valid', async () => {
    const a = await sealOf(fx, p.id, r.id);
    const b = await sealOf(fx, p.id, r.id);
    await withTriggersDisabled('seals', () => testDb.$executeRaw`
      UPDATE seals SET manifest = (SELECT manifest FROM seals WHERE id = ${a.id}), fingerprint = (SELECT fingerprint FROM seals WHERE id = ${a.id}) WHERE id = ${b.id}`);
    expect(await checkSeal(ctxFor(fx, 'viewer'), b.id)).toEqual({ kind: 'mismatch', firstDifference: 'seal.id' });
    expect((await checkSeal(ctxFor(fx, 'viewer'), a.id)).kind).toBe('valid');
  });

  it('FR-REV-06 FR-REV-08: a reason erased by the operator procedure reads valid with one field erased', async () => {
    const s = await sealOf(fx, p.id, r.id);
    await asOperator(`SELECT erase_text_field('${fx.org.id}','decision_versions','${v1}','reason','ER-1','INSTR-1')`);
    expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toMatchObject({ kind: 'valid', erasedFields: 1, erasedFiles: 0 });
  });

  it('FR-REV-06 (M-2): an unrelated tombstone the format cannot read never stops a check', async () => {
    const s = await sealOf(fx, p.id, r.id);
    await testDb.$executeRaw`INSERT INTO tombstones ("id", "orgId", "targetTable", "targetId", "field", "digest", "erasureCode", "instructionReference", "at")
      VALUES (${randomUUID()}, ${fx.org.id}, 'evidence', 'no-such-row', NULL, NULL, 'ER-X', 'INSTR-X', 'infinity')`;
    expect((await checkSeal(ctxFor(fx, 'viewer'), s.id)).kind).toBe('valid');
  });

  it('NFR-INT-05 (R2-21): SEAL_SOURCE_SQL in a UTC session returns rows in row_to_json form that check valid', async () => {
    const s = await sealOf(fx, p.id, r.id);
    const rows = await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
      return Object.fromEntries(await Promise.all(Object.entries(SEAL_SOURCE_SQL).map(async ([t, sql]) => [t, (await tx.$queryRawUnsafe<{ r: unknown }[]>(sql, fx.org.id)).map((x) => x.r)])));
    });
    expect(Object.keys(rows).sort()).toEqual([...SEAL_SOURCE_TABLES, 'tombstones'].sort());
    expect((rows.seals as Array<{ sealedAt: string }>)[0].sealedAt).toMatch(/\+00:00$/);
    const { tombstones, ...source } = rows;
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: s.id } });
    expect(checkSealRows({ sealId: row.id, manifestBytes: row.manifest, fingerprint: row.fingerprint, rows: source as unknown as SealSourceRows, tombstones: tombstones as TombstoneRow[] }).kind).toBe('valid');
  });

  it('FR-REV-04: UPDATE and DELETE on seals fail for every database role', async () => {
    const s = await sealOf(fx, p.id, r.id);
    for (const role of ['makrai_app', 'makrai_identity', 'makrai_operator_fn', 'makrai'])
      for (const stmt of [`UPDATE seals SET "sealNumber" = 9 WHERE id = '${s.id}'`, `DELETE FROM seals WHERE id = '${s.id}'`])
        await expect(runAsRole(role, stmt), `${role}: ${stmt}`).rejects.toThrow(/append-only|permission denied/);
    expect(await testDb.seal.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ sealNumber: 1, fingerprint: s.fingerprint });
  });

  it('NFR-SEC-02 FR-REV-06: a seal of organisation B, or of another review, answers 404 on GET check', async () => {
    const s = await sealOf(fx, p.id, r.id);
    const pB = await addProject(fxB);
    await addDecision(fxB, pB.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' });
    const sealOfB = await sealOf(fxB, pB.id, (await addStageReview(fxB, pB.id, { stage: 'pre-processing' })).id);
    const otherProject = await addProject(fx);
    expect((await getCheck(p.id, r.id, sealOfB.id, 'viewer')).status).toBe(404);
    expect((await getCheck(p.id, r2.id, s.id, 'viewer')).status).toBe(404);
    expect((await getCheck(otherProject.id, r.id, s.id, 'viewer')).status).toBe(404);
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) {   // every member may check (UX-19, call U11)
      const res = await getCheck(p.id, r.id, s.id, role);
      expect([res.status, (await res.json()).kind], role).toEqual([200, 'valid']);
    }
  });

  it('FR-REV-06 NFR-OBS-01: a failed check logs one SEAL_CHECK_FAILED with the seal id and kind', async () => {
    const tampered = await sealOf(fx, p.id, r.id);
    await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET reason = 'changed' WHERE id = ${v1}`);
    const { lines } = await captureLogs(() => checkSeal(ctxFor(fx, 'viewer'), tampered.id));
    expect(lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CHECK_FAILED').map((e) => e.details))
      .toEqual([{ sealId: tampered.id, kind: 'mismatch' }]);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('FR-REV-05 NFR-SEC-01 (helper): sealsIncludingRows finds the seals naming a row and no seal of organisation B', async () => {
    const s = await sealOf(fx, p.id, r.id);
    expect((await sealsIncludingRows(ctxFor(fx, 'viewer'), [v1])).get(v1)).toEqual([{ sealId: s.id, sealNumber: 1, reviewId: r.id, reviewName: 'Pre-processing review 1' }]);
    const pB = await addProject(fxB);
    const versionOfB = (await addDecision(fxB, pB.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' })).id;
    await sealOf(fxB, pB.id, (await addStageReview(fxB, pB.id, { stage: 'pre-processing' })).id);
    expect(await sealsIncludingRows(ctxFor(fx, 'viewer'), [versionOfB])).toEqual(new Map());
    expect(await sealsIncludingRows(ctxFor(fx, 'viewer'), [])).toEqual(new Map());
    // An id that only appears inside another id, or in free text, is not counted: the parsed manifest must name it.
    expect(await sealsIncludingRows(ctxFor(fx, 'viewer'), [v1.slice(0, 8)])).toEqual(new Map());
  });

  it('FR-REV-05 NFR-INT-05 NFR-OBS-01: sealsIncludingRows credits no damaged or copied seal, and logs each it leaves out', async () => {
    const a = await sealOf(fx, p.id, r.id);
    const b = await sealOf(fx, p.id, r2.id);
    await withTriggersDisabled('seals', () => testDb.$executeRaw`
      UPDATE seals SET manifest = (SELECT manifest FROM seals WHERE id = ${a.id}), fingerprint = (SELECT fingerprint FROM seals WHERE id = ${a.id}) WHERE id = ${b.id}`);
    const copied = await captureLogs(() => sealsIncludingRows(ctxFor(fx, 'viewer'), [v1]));
    expect(copied.result.get(v1)?.map((x) => x.sealId)).toEqual([a.id]);
    expect(copied.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CHECK_FAILED').map((e) => e.details))
      .toEqual([{ sealId: b.id, kind: 'mismatch' }]);
    await withTriggersDisabled('seals', () => testDb.$executeRaw`UPDATE seals SET manifest = manifest || '\x20'::bytea WHERE id = ${a.id}`);
    const damaged = await captureLogs(() => sealsIncludingRows(ctxFor(fx, 'viewer'), [v1]));
    expect(damaged.result).toEqual(new Map());
    // Each damaged seal is logged once per process, not once per page view (RE-4): b was logged on the first call.
    expect(damaged.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CHECK_FAILED').map((e) => e.details))
      .toEqual([{ sealId: a.id, kind: 'fingerprint_mismatch' }]);
    const third = await captureLogs(() => sealsIncludingRows(ctxFor(fx, 'viewer'), [v1]));
    expect(third.lines.filter((l) => l.includes('SEAL_CHECK_FAILED'))).toEqual([]);
  });

  it('FR-REV-06 (A7): a NULL text array on a sealed version (its NOT NULL dropped) reads mismatch at its path', async () => {
    const s = await sealOf(fx, p.id, r.id);
    await testDb.$executeRawUnsafe('ALTER TABLE decision_versions ALTER COLUMN "optionsInPlace" DROP NOT NULL');
    try {
      await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET "optionsInPlace" = NULL WHERE id = ${v1}`);
      expect(await checkSeal(ctxFor(fx, 'viewer'), s.id)).toEqual({ kind: 'mismatch', firstDifference: 'decisions[Q-PP-01].optionsInPlace' });
    } finally {
      await withTriggersDisabled('decision_versions', () => testDb.$executeRaw`UPDATE decision_versions SET "optionsInPlace" = '{}' WHERE "optionsInPlace" IS NULL`);
      await testDb.$executeRawUnsafe('ALTER TABLE decision_versions ALTER COLUMN "optionsInPlace" SET NOT NULL');
    }
  });

  it('FR-REV-06 NFR-OBS-01: a check that cannot finish throws, and still logs one SEAL_CHECK_FAILED', async () => {
    const s = await sealOf(fx, p.id, r.id);
    broken.next = true;   // the next checkSealRows throws, as it does for a row lacking a column (a caller defect)
    const out = await captureLogs(() => checkSeal(ctxFor(fx, 'viewer'), s.id).catch((e: unknown) => e));
    expect(out.result).toBeInstanceOf(TypeError);
    expect(out.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CHECK_FAILED').map((e) => e.details))
      .toEqual([{ sealId: s.id, kind: 'unreadable' }]);
  });

  it('FR-REV-05 NFR-OBS-01 (CR-3): stored bytes that match their fingerprint but are no manifest are left out and logged, never thrown', async () => {
    const good = await sealOf(fx, p.id, r.id);
    const odd = await sealOf(fx, p.id, r2.id);
    const bytes = Buffer.from(JSON.stringify({ x: v1 }));   // names the id, but is not a makrai.seal/1 manifest
    await withTriggersDisabled('seals', () => testDb.$executeRaw`
      UPDATE seals SET manifest = ${Uint8Array.from(bytes)}, fingerprint = encode(sha256(${Uint8Array.from(bytes)}), 'hex') WHERE id = ${odd.id}`);
    const out = await captureLogs(() => sealsIncludingRows(ctxFor(fx, 'viewer'), [v1]));
    expect(out.result.get(v1)?.map((x) => x.sealId)).toEqual([good.id]);
    expect(out.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CHECK_FAILED').map((e) => e.details))
      .toEqual([{ sealId: odd.id, kind: 'mismatch' }]);
    expect(await checkSeal(ctxFor(fx, 'viewer'), odd.id)).toEqual({ kind: 'mismatch', firstDifference: 'format' });
  });

  it('FR-REV-04 (W-7 note 2, SPEC-1): listSeals returns a review\'s seals newest first, each with bytesMatch', async () => {
    await sealOf(fx, p.id, r.id);
    await sealOf(fx, p.id, r.id);
    const list = await listSeals(ctxFor(fx, 'viewer'), r.id);
    expect(list.map((x) => x.sealNumber)).toEqual([2, 1]);
    expect(list.every((x) => x.bytesMatch && x.reviewId === r.id)).toBe(true);
    expect(await listSeals(ctxFor(fx, 'viewer'), r2.id)).toEqual([]);
  });
});
