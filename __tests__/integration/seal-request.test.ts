import { randomUUID as uuid } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { resetDb, testDb } from '../helpers/db';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addProject, addSealRow, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';

// Concurrent route calls need the identity step queued (the vitest limitation is stated at queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

/**
 * Design G2 and SRS FR-DOC-09 clause 10: the seal request. An Assessor, who may open a review but not seal one, asks for
 * a seal; the request is idempotent per stage (it returns the stage's open review, or opens one as FR-REV-01 does), and
 * concurrent requests for one stage open at most one review, serialised by a per-stage advisory lock.
 */
const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/seal-request/route.ts';
const OPEN_ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts';
const STAGE = 'pre-processing';

let fx: OrgFixture;
let p: { id: string };

async function ask(projectId: string, body: unknown, role: OrgRole = 'assessor', org: OrgFixture = fx): Promise<Response> {
  sessionAs(org.members[role].userId);
  return callRoute(ROUTE, 'POST', { slug: org.org.slug, params: { id: projectId }, body });
}

/** What a refused request must leave as it was: the reviews and the receipts. */
const written = async () => ({ reviews: await testDb.stageReview.count(), receipts: await testDb.requestReceipt.count() });

/** Ungranted advisory locks: requests waiting on a lock the test holds. */
const advisoryWaiters = async () =>
  Number((await testDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n);

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  p = await addProject(fx);
});

describe('the seal request (design G2)', () => {
  it('Review Focus 4: two seal requests in sequence, with different request ids, return the same review and one row exists', async () => {
    const first = await ask(p.id, { requestId: uuid(), stage: STAGE });
    const second = await ask(p.id, { requestId: uuid(), stage: STAGE });
    const [a, b] = [await first.json(), await second.json()];
    expect([first.status, second.status]).toEqual([201, 200]);
    expect([a.name, b.id]).toEqual(['Pre-processing review 1', a.id]);
    expect(await testDb.stageReview.count({ where: { projectId: p.id } })).toBe(1);
    const row = await testDb.stageReview.findUniqueOrThrow({ where: { id: a.id } });
    expect([row.openedById, row.preparedFor, row.numberInStage]).toEqual([fx.members.assessor.userId, null, 1]);
  });

  it('Review Focus 4: two seal requests sent together return the same review', async () => {
    // The test holds the stage's lock, starts two requests with different ids, and lets go only once both are waiting on
    // it: they then run one after the other whatever the timing. Without the lock in the service, the waiters never appear.
    const [r1, r2] = await testDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('makrai.seal-request:' || ${p.id}::text || ':' || ${STAGE}::text, 0))`;
      const both = Promise.all([ask(p.id, { requestId: uuid(), stage: STAGE }), ask(p.id, { requestId: uuid(), stage: STAGE })]);
      const deadline = Date.now() + 15_000;
      while ((await advisoryWaiters()) < 2) {
        if (Date.now() > deadline) throw new Error('the two seal requests never waited on the stage lock');
        await new Promise((r) => setTimeout(r, 20));
      }
      return [both] as const;
    }, { timeout: 30_000 }).then(async ([both]) => both);
    const [a, b] = [await r1.json(), await r2.json()];
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(b.id).toBe(a.id);
    expect(await testDb.stageReview.count({ where: { projectId: p.id } })).toBe(1);
  }, 40_000);

  it('Review Focus 4: two seal requests sent together, with no lock held by the test, open one review', async () => {
    const rs = await Promise.all([ask(p.id, { requestId: uuid(), stage: STAGE }), ask(p.id, { requestId: uuid(), stage: STAGE })]);
    const ids = await Promise.all(rs.map(async (r) => (await r.json()).id));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(ids[1]).toBe(ids[0]);
    expect(await testDb.stageReview.count({ where: { projectId: p.id } })).toBe(1);
  });

  it('a review FR-REV-01 opens at the same moment takes the number; the seal request then returns that review, not 409', async () => {
    // FR-REV-01's open takes no stage lock. The test opens review 1 in a transaction it keeps open, so the seal request,
    // which cannot see it yet, inserts number 1 too and waits on the unique index; the test then commits.
    let mine = '';
    const res = await testDb.$transaction(async (tx) => {
      mine = (await tx.stageReview.create({ data: {
        orgId: fx.org.id, projectId: p.id, stage: STAGE, numberInStage: 1, openedById: fx.members.owner.userId, requestId: uuid(), requestDigest: 'd',
      } })).id;
      const pending = ask(p.id, { requestId: uuid(), stage: STAGE });
      const deadline = Date.now() + 15_000;
      const waiting = async () => Number((await testDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted`)[0].n);
      while ((await waiting()) < 1) {
        if (Date.now() > deadline) throw new Error('the seal request never waited on the open review\'s number');
        await new Promise((r) => setTimeout(r, 20));
      }
      return [pending] as const;
    }, { timeout: 30_000 }).then(([pending]) => pending);
    expect([res.status, (await res.json()).id]).toEqual([200, mine]);
    expect(await testDb.stageReview.count({ where: { projectId: p.id } })).toBe(1);
  }, 40_000);

  it('a seal request with an unsealed review 1 and a sealed review 2 returns review 1', async () => {
    const one = await addStageReview(fx, p.id, { stage: STAGE });
    const two = await addStageReview(fx, p.id, { stage: STAGE });
    await addSealRow(fx, two.id);
    const res = await ask(p.id, { requestId: uuid(), stage: STAGE });
    expect([res.status, (await res.json()).id]).toEqual([200, one.id]);
    expect(await testDb.stageReview.count({ where: { projectId: p.id } })).toBe(2);
  });

  it('a seal request when every review of the stage is sealed opens the next one, numbered as FR-REV-01 numbers it', async () => {
    const one = await addStageReview(fx, p.id, { stage: STAGE });
    await addSealRow(fx, one.id);
    const res = await ask(p.id, { requestId: uuid(), stage: STAGE });
    const json = await res.json();
    expect([res.status, json.name]).toEqual([201, 'Pre-processing review 2']);
    // Another stage's open review is not this stage's.
    await addStageReview(fx, p.id, { stage: 'in-processing' });
    expect((await ask(p.id, { requestId: uuid(), stage: 'in-processing' })).status).toBe(200);
    expect((await (await ask(p.id, { requestId: uuid(), stage: STAGE })).json()).id).toBe(json.id);
  });

  it('a Reviewer or Viewer gets 403 and nothing is written; an archived project answers 409 project_archived', async () => {
    const before = await written();
    for (const role of ['reviewer', 'viewer'] as const) {
      const res = await ask(p.id, { requestId: uuid(), stage: STAGE }, role);
      expect([role, res.status, (await res.json()).code]).toEqual([role, 403, 'forbidden']);
    }
    const archived = await addProject(fx, { archived: true });
    const res = await ask(archived.id, { requestId: uuid(), stage: STAGE });
    expect([res.status, (await res.json()).code]).toEqual([409, 'project_archived']);
    expect(await written()).toEqual(before);
  });

  it('NFR-SEC-02: another organisation\'s project is not found, and nothing is written', async () => {
    const other = await buildOrg({ label: 'b' });
    const theirs = await addProject(other);
    const before = await written();
    const res = await ask(theirs.id, { requestId: uuid(), stage: STAGE });
    expect(res.status).toBe(404);
    expect(await written()).toEqual(before);
  });

  it('the body is exactly { requestId, stage }: another key, a stage that is not one, or a bad request id is refused on its field', async () => {
    const before = await written();
    for (const [bad, field] of [
      [{ requestId: uuid(), stage: STAGE, preparedFor: 'x' }, 'preparedFor'],
      [{ requestId: uuid(), stage: 'processing' }, 'stage'],
      [{ requestId: uuid() }, 'stage'],
      [{ requestId: 'not-a-uuid', stage: STAGE }, 'requestId'],
    ] as const) {
      const res = await ask(p.id, bad);
      expect([res.status, (await res.json()).fields.map((f: { field: string }) => f.field)]).toEqual([422, [field]]);
    }
    for (const bad of [[], 'text', null]) expect((await ask(p.id, bad)).status).toBe(422);
    expect(await written()).toEqual(before);
  });

  it('NFR-INT-02: a request id already used to open a review is refused 409 request_id_reused, not a server error', async () => {
    const requestId = uuid();
    sessionAs(fx.members.assessor.userId);
    const opened = await callRoute(OPEN_ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id }, body: { requestId, stage: STAGE, preparedFor: null } });
    expect(opened.status).toBe(201);
    await addSealRow(fx, (await opened.json()).id);
    const before = await written();
    const res = await ask(p.id, { requestId, stage: STAGE });
    expect([res.status, (await res.json()).code]).toEqual([409, 'request_id_reused']);
    expect(await written()).toEqual(before);
  });

  it('openStageReview still opens review 2 while review 1 is unsealed (FR-REV-01 unchanged)', async () => {
    const asked = await (await ask(p.id, { requestId: uuid(), stage: STAGE })).json();
    sessionAs(fx.members.assessor.userId);
    const res = await callRoute(OPEN_ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id }, body: { requestId: uuid(), stage: STAGE, preparedFor: null } });
    const json = await res.json();
    expect([res.status, json.name]).toEqual([201, 'Pre-processing review 2']);
    expect(json.id).not.toBe(asked.id);
    // The seal request now returns the newest open review, review 2.
    expect((await (await ask(p.id, { requestId: uuid(), stage: STAGE })).json()).id).toBe(json.id);
  });
});
