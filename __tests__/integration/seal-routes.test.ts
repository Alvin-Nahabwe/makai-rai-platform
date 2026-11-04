import { randomUUID as uuid } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerText } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addDecision, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';

// Concurrent route calls need the identity step queued (the vitest limitation is stated at queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

// The 40001 cases change the project on another connection after the seal's snapshot, just before its FOR SHARE
// lock: the hook runs once, inside sealStageReview's first attempt, then the real guard runs.
const guard = vi.hoisted(() => ({ before: null as null | ((projectId: string) => Promise<void>) }));
vi.mock('@/lib/data/projectGuard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/projectGuard')>();
  return {
    ...real,
    assertProjectWritable: async (...args: Parameters<typeof real.assertProjectWritable>) => {
      const hook = guard.before;
      guard.before = null;
      if (hook) await hook(args[1]);
      return real.assertProjectWritable(...args);
    },
  };
});

/** Contract route row 13: POST .../reviews/[reviewId]/seals, driven through the real handler (routeDriver). */
const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };
let r: { id: string };
let r2: { id: string };

async function postSeal(projectId: string, reviewId: string, body: unknown, role: OrgRole, org: OrgFixture = fx): Promise<Response> {
  sessionAs(org.members[role].userId);
  return callRoute(ROUTE, 'POST', { slug: org.org.slug, params: { id: projectId, reviewId }, body });
}

beforeEach(async () => {
  guard.before = null;
  await resetDb();
  const fv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx);
  await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20' });
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  r2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('route 13: seal a stage review', () => {
  it('NFR-INT-02 FR-REV-03: the same request id on another review answers 409 and writes nothing', async () => {
    const REQ = uuid();
    const first = await postSeal(p.id, r.id, { requestId: REQ }, 'reviewer');
    expect(first.status).toBe(201);
    const again = await postSeal(p.id, r.id, { requestId: REQ }, 'reviewer');
    expect([again.status, (await again.json()).id]).toEqual([200, (await first.json()).id]);
    const other = await postSeal(p.id, r2.id, { requestId: REQ }, 'reviewer');   // digest covers { id, reviewId }
    expect([other.status, (await other.json()).code]).toEqual([409, 'request_id_reused']);
    expect(await testDb.seal.count()).toBe(1);
  });

  it('FR-REV-03 NFR-INT-04: a seal request carrying manifest, sealedBy or sealedAt is refused with 422 and writes nothing', async () => {
    const other = fx.members.owner.userId;
    for (const extra of [{ manifest: '{}' }, { sealedBy: other }, { sealedAt: '2000-01-01T00:00:00.000Z' }, { sealNumber: 9 }]) {
      const res = await postSeal(p.id, r.id, { requestId: uuid(), ...extra }, 'owner');
      const json = await res.json();
      expect([res.status, json.code, json.fields?.[0]?.field]).toEqual([422, 'validation', Object.keys(extra)[0]]);
    }
    for (const bad of [{}, { requestId: 'not-a-uuid' }, [], 'text'])
      expect((await postSeal(p.id, r.id, bad, 'owner')).status).toBe(422);
    expect(await testDb.seal.count()).toBe(0);
    const ok = await (await postSeal(p.id, r.id, { requestId: uuid() }, 'reviewer')).json();
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: ok.id } });
    expect([row.sealedById, row.sealedByRole, row.sealNumber]).toEqual([fx.members.reviewer.userId, 'reviewer', 1]);
    expect(JSON.parse(Buffer.from(row.manifest).toString('utf8')).seal.sealedAt).toBe(row.sealedAt.toISOString());   // contract Data model Seal, G012
    expect(ok.sealedAt).toBe(row.sealedAt.toISOString());
  });

  it('FR-REV-03 FR-AUTHZ-01: assessor and viewer get 403 forbidden on POST seals and no row is written', async () => {
    for (const role of ['assessor', 'viewer'] as const) {
      const res = await postSeal(p.id, r.id, { requestId: uuid() }, role);
      expect([res.status, (await res.json()).code]).toEqual([403, 'forbidden']);
    }
    expect(await testDb.seal.count()).toBe(0);
  });

  it('NFR-SEC-02 FR-REV-03: a review of organisation B, or of another project, answers 404 on POST seals', async () => {
    const pB = await addProject(fxB);
    const reviewOfB = await addStageReview(fxB, pB.id, { stage: 'pre-processing' });
    const otherProject = await addProject(fx);
    expect((await postSeal(p.id, reviewOfB.id, { requestId: uuid() }, 'owner')).status).toBe(404);
    expect((await postSeal(pB.id, reviewOfB.id, { requestId: uuid() }, 'owner')).status).toBe(404);
    expect((await postSeal(otherProject.id, r.id, { requestId: uuid() }, 'owner')).status).toBe(404);
    expect(await testDb.seal.count()).toBe(0);
  });

  it('FR-PRJ-03 (helper): sealing a review of an archived project answers 409 project_archived and writes nothing', async () => {
    const archived = await addProject(fx, { archived: true });
    const rOfArchived = await addStageReview(fx, archived.id, { stage: 'pre-processing' });
    const res = await postSeal(archived.id, rOfArchived.id, { requestId: uuid() }, 'owner');
    expect([res.status, (await res.json()).code]).toEqual([409, 'project_archived']);
    expect(await testDb.seal.count()).toBe(0);
  });

  it('FR-REV-03 (5.3 item 3): two concurrent seals of one review give consecutive numbers or one 409 number_taken', async () => {
    const res = await Promise.all([postSeal(p.id, r.id, { requestId: uuid() }, 'owner'), postSeal(p.id, r.id, { requestId: uuid() }, 'owner')]);
    const bodies = await Promise.all(res.map((x) => x.json()));
    for (const [i, x] of res.entries()) if (x.status !== 201) expect([x.status, bodies[i].code]).toEqual([409, 'number_taken']);
    const numbers = (await testDb.seal.findMany({ where: { stageReviewId: r.id }, orderBy: { sealNumber: 'asc' } })).map((s) => s.sealNumber);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(numbers.length).toBe(res.filter((x) => x.status === 201).length);
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('NFR-OBS-01 NFR-PRIV-03: one SEAL_CREATED line per seal with ids only, none on a replay', async () => {
    const REQ = uuid();
    const { result, lines } = await captureLogs(async () => {
      const s = await postSeal(p.id, r.id, { requestId: REQ }, 'reviewer');
      await postSeal(p.id, r.id, { requestId: REQ }, 'reviewer');
      return s.json();
    });
    const ev = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.event === 'SEAL_CREATED');
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0].details).sort()).toEqual(['fingerprint', 'sealId', 'sealNumber', 'sealedAt']);
    expect(ev[0].details).toMatchObject({ sealId: result.id, fingerprint: result.fingerprint, sealNumber: 1, sealedAt: result.sealedAt });
    expect(ev[0].userId).toBeUndefined();
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('FR-REV-03 (5.3 item 3): a seal whose number another transaction takes first answers 409 number_taken and writes nothing', async () => {
    // Another connection inserts seal 1 of the review and holds its transaction open; the route then reads no seal
    // (not committed), builds seal 1, waits on the unique index, and fails once the holder commits.
    let inserted!: () => void;
    const held = new Promise<void>((res) => { inserted = res; });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const holder = testDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${fx.org.id}, true)`;
      await tx.seal.create({ data: {
        orgId: fx.org.id, stageReviewId: r.id, sealNumber: 1, format: 'makrai.seal/1',
        contentVersionId: (await tx.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' }, select: { id: true } })).id,
        manifest: Uint8Array.from(Buffer.from('{}')), fingerprint: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        sealedById: fx.members.owner.userId, sealedByRole: 'owner', requestId: uuid(), requestDigest: '0'.repeat(64),
      } });
      inserted();
      await gate;
    }, { timeout: 20_000 });
    await held;
    const pending = postSeal(p.id, r.id, { requestId: uuid() }, 'owner');
    await new Promise((res) => setTimeout(res, 750));   // the route reaches its insert and waits on the index
    release();
    await holder;
    const res = await pending;
    expect([res.status, (await res.json()).code]).toEqual([409, 'number_taken']);
    expect(await testDb.seal.count({ where: { stageReviewId: r.id } })).toBe(1);
  });

  it('FR-PRJ-03 NFR-INT-10 (F4): a project archived after the seal took its snapshot answers 409 project_archived, not 500', async () => {
    guard.before = async (projectId) => { await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } }); };
    const res = await postSeal(p.id, r.id, { requestId: uuid() }, 'owner');
    expect([res.status, (await res.json()).code]).toEqual([409, 'project_archived']);
    expect(guard.before).toBeNull();   // the change ran inside the first attempt
    expect(await testDb.seal.count()).toBe(0);
  });

  it('FR-REV-03 NFR-INT-10 (F4): a project renamed after the seal took its snapshot still seals, once', async () => {
    guard.before = async (projectId) => { await testDb.project.update({ where: { id: projectId }, data: { name: 'Renamed mid-seal' } }); };
    const REQ = uuid();
    const res = await postSeal(p.id, r.id, { requestId: REQ }, 'owner');
    const body = await res.json();
    expect([res.status, body.sealNumber]).toEqual([201, 1]);
    expect(await testDb.seal.count()).toBe(1);
    const again = await postSeal(p.id, r.id, { requestId: REQ }, 'owner');   // the retry did not spoil replay
    expect([again.status, (await again.json()).id]).toEqual([200, body.id]);
  });
});
