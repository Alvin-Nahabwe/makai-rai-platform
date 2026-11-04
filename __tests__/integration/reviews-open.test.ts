import { randomUUID as uuid } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { resetDb, testDb } from '../helpers/db';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor, markerText } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { listStageReviews } from '@/lib/data/reviews';

// Concurrent route calls need the identity step queued (the vitest limitation is stated at queuedIdentity).
vi.mock('@/lib/auth/identity', async (importOriginal) =>
  (await import('../helpers/authSession')).queuedIdentity(await importOriginal<typeof import('@/lib/auth/identity')>()));

/** Contract route row 12: POST .../projects/[id]/reviews, driven through the real handler (routeDriver). */
const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts';

let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };
let p2: { id: string };

async function postReview(projectId: string, body: unknown, role: OrgRole, org: OrgFixture = fx): Promise<Response> {
  sessionAs(org.members[role].userId);
  return callRoute(ROUTE, 'POST', { slug: org.org.slug, params: { id: projectId }, body });
}

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg({ text: markerText });
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx);
  p2 = await addProject(fx);
});

describe('route 12: open a stage review', () => {
  it('FR-REV-01: reviews are named by stage and number, the note is optional and capped at 120 characters, a name is refused', async () => {
    const one = await postReview(p.id, { requestId: uuid(), stage: 'in-processing', preparedFor: 'Journal submission' }, 'admin');
    const oneJson = await one.json();
    expect([one.status, oneJson.name, oneJson.preparedFor]).toEqual([201, 'In-processing review 1', 'Journal submission']);
    const two = await (await postReview(p.id, { requestId: uuid(), stage: 'in-processing', preparedFor: null }, 'admin')).json();
    expect([two.name, two.preparedFor]).toEqual(['In-processing review 2', null]);
    const named = await postReview(p.id, { requestId: uuid(), stage: 'in-processing', preparedFor: null, name: 'Mine' }, 'admin');
    expect([named.status, (await named.json()).fields[0].field]).toEqual([422, 'name']);
    const long = await postReview(p.id, { requestId: uuid(), stage: 'in-processing', preparedFor: 'a'.repeat(121) }, 'admin');
    const longJson = await long.json();
    expect([long.status, longJson.fields[0].field, longJson.fields[0].message]).toEqual([422, 'preparedFor', 'The note can have at most 120 characters.']);
    expect(await testDb.stageReview.count()).toBe(2);
  });

  it('FR-REV-01: the note is stored in NFC and counted after NFC', async () => {
    const decomposed = 'é'.repeat(120);   // 240 code points before NFC, 120 after
    const res = await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: decomposed }, 'assessor');
    expect(res.status).toBe(201);
    const row = await testDb.stageReview.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(row.preparedFor).toBe('é'.repeat(120));
    // An emoji is one code point and two UTF-16 units: 120 of them are allowed, 121 are not.
    expect((await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: '\u{1F600}'.repeat(120) }, 'assessor')).status).toBe(201);
    expect((await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: '\u{1F600}'.repeat(121) }, 'assessor')).status).toBe(422);
  });

  it('FR-REV-01: an empty note is stored as no note, and a note or stage of the wrong type is refused on its field', async () => {
    const empty = await (await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: '' }, 'owner')).json();
    expect(empty.preparedFor).toBeNull();
    expect((await testDb.stageReview.findUniqueOrThrow({ where: { id: empty.id } })).preparedFor).toBeNull();
    for (const [bad, field] of [
      [{ requestId: uuid(), stage: 'pre-processing', preparedFor: 7 }, 'preparedFor'],
      [{ requestId: uuid(), stage: 'pre-processing' }, 'preparedFor'],
      [{ requestId: uuid(), stage: 'processing', preparedFor: null }, 'stage'],
      [{ requestId: 'not-a-uuid', stage: 'pre-processing', preparedFor: null }, 'requestId'],
    ] as const) {
      const res = await postReview(p.id, bad, 'owner');
      expect([res.status, (await res.json()).fields.map((f: { field: string }) => f.field)]).toEqual([422, [field]]);
    }
    for (const bad of [[], 'text', null]) expect((await postReview(p.id, bad, 'owner')).status).toBe(422);
    expect(await testDb.stageReview.count()).toBe(1);
  });

  it('FR-REV-01 NFR-INT-04: a note the database cannot store as sent (a NUL, a lone surrogate) is refused with 422, not stored altered', async () => {
    for (const note of ['a\u0000b', 'a\ud800b', 'a\udc00b']) {
      const res = await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: note }, 'owner');
      const json = await res.json();
      expect([res.status, json.fields?.[0]?.field, json.fields?.[0]?.message])
        .toEqual([422, 'preparedFor', 'This contains a character that cannot be stored. Remove it and save again.']);
    }
    expect(await testDb.stageReview.count()).toBe(0);
    expect((await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: 'a\u{1F600}b' }, 'owner')).status).toBe(201);   // a surrogate pair is fine
  });

  it('FR-REV-01: numberInStage and openedById come from the server', async () => {
    const other = fx.members.viewer.userId;
    for (const extra of [{ numberInStage: 7 }, { openedById: other }]) {
      const res = await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null, ...extra }, 'owner');
      expect([res.status, (await res.json()).fields[0].field]).toEqual([422, Object.keys(extra)[0]]);
    }
    const r = await (await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, 'owner')).json();
    expect([r.openedBy.userId, r.numberInStage]).toEqual([fx.members.owner.userId, 1]);
    expect((await testDb.stageReview.findUniqueOrThrow({ where: { id: r.id } })).openedById).toBe(fx.members.owner.userId);
  });

  it('FR-REV-01 FR-AUTHZ-01: reviewer and viewer get 403 on POST reviews and nothing is written', async () => {
    for (const role of ['reviewer', 'viewer'] as const) {
      const res = await postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, role);
      expect([res.status, (await res.json()).code]).toEqual([403, 'forbidden']);
    }
    expect(await testDb.stageReview.count()).toBe(0);
  });

  it('NFR-SEC-02 FR-REV-01: a project of organisation B, or an unknown project id, answers 404 on POST reviews and nothing is written', async () => {
    const pB = await addProject(fxB);
    for (const id of [pB.id, uuid()]) {
      const res = await postReview(id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, 'owner');
      expect(res.status).toBe(404);
    }
    expect(await testDb.stageReview.count()).toBe(0);
  });

  it('NFR-INT-02 FR-REV-01: the same request id on another project answers 409 and writes nothing', async () => {
    const body = { requestId: uuid(), stage: 'pre-processing', preparedFor: 'Ethics submission' };
    const first = await postReview(p.id, body, 'assessor');
    expect(first.status).toBe(201);
    const again = await postReview(p.id, body, 'assessor');
    expect([again.status, (await again.json()).id]).toEqual([200, (await first.json()).id]);
    const other = await postReview(p2.id, body, 'assessor');   // digest covers { id }
    expect([other.status, (await other.json()).code]).toEqual([409, 'request_id_reused']);
    expect(await testDb.stageReview.count()).toBe(1);
  });

  it('FR-REV-01 (5.3 item 3): two concurrent opens in one stage give consecutive numbers or one 409 number_taken', async () => {
    // Concurrent calls share one session (queuedIdentity), so both are the owner's.
    const res = await Promise.all([
      postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, 'owner'),
      postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, 'owner'),
    ]);
    const bodies = await Promise.all(res.map((x) => x.json()));
    for (const [i, x] of res.entries()) if (x.status !== 201) expect([x.status, bodies[i].code]).toEqual([409, 'number_taken']);
    const numbers = (await testDb.stageReview.findMany({ where: { projectId: p.id, stage: 'pre-processing' }, orderBy: { numberInStage: 'asc' } })).map((r) => r.numberInStage);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(numbers.length).toBe(res.filter((x) => x.status === 201).length);
    expect(numbers.length).toBeGreaterThan(0);
  });

  it('FR-PRJ-03 (helper): opening a review in an archived project answers 409 project_archived', async () => {
    const archived = await addProject(fx, { archived: true });
    const res = await postReview(archived.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: null }, 'owner');
    expect([res.status, (await res.json()).code]).toEqual([409, 'project_archived']);
    expect(await testDb.stageReview.count()).toBe(0);
  });

  it('NFR-PRIV-03 NFR-PRIV-04: opening a review with a marker note logs no marker', async () => {
    const note = markerFor('preparedFor', 1);
    const { result, lines } = await captureLogs(() => postReview(p.id, { requestId: uuid(), stage: 'pre-processing', preparedFor: note }, 'owner'));
    expect(result.status).toBe(201);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-PRIV-04: the open form posts the note in a JSON body and never puts it in an address', () => {
    const form = readFileSync('components/review/OpenReviewForm.tsx', 'utf8');
    expect(form).not.toMatch(/searchParams|URLSearchParams|\?preparedFor|preparedFor=/);
    expect(form).toMatch(/sendWrite<StageReviewView>\(url, 'POST', \{ \.\.\.body, requestId \}/);
  });
});

describe('listStageReviews', () => {
  it('NFR-SEC-02 FR-REV-01: a review of organisation B, or of another project, is not found', async () => {
    const projectOfB = await addProject(fxB);
    await addStageReview(fxB, projectOfB.id, { stage: 'pre-processing' });
    const reviewOfP1 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    expect(await listStageReviews(ctxFor(fx, 'viewer'), projectOfB.id)).toEqual([]);
    expect((await listStageReviews(ctxFor(fx, 'viewer'), p2.id)).map((r) => r.id)).not.toContain(reviewOfP1.id);
    expect((await listStageReviews(ctxFor(fx, 'viewer'), p.id)).map((r) => r.id)).toEqual([reviewOfP1.id]);
  });

  it('FR-REV-01: reviews are listed in stage order then by number, named by the platform, with opener and no seal yet', async () => {
    const post1 = await addStageReview(fx, p.id, { stage: 'post-processing', preparedFor: 'Data transfer agreement', by: 'admin' });
    const pre2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const pre1b = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const all = await listStageReviews(ctxFor(fx, 'viewer'), p.id);
    expect(all.map((r) => [r.id, r.name])).toEqual([
      [pre2.id, 'Pre-processing review 1'], [pre1b.id, 'Pre-processing review 2'], [post1.id, 'Post-processing review 1'],
    ]);
    const post = all[2];
    expect(post).toMatchObject({
      projectId: p.id, stage: 'post-processing', numberInStage: 1, preparedFor: 'Data transfer agreement',
      openedBy: { userId: fx.members.admin.userId, name: fx.members.admin.name }, latestSeal: null, changedSinceLatestSeal: false,
      changed: null, preparedForErased: null,
    });
    expect(post.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect((await listStageReviews(ctxFor(fx, 'viewer'), p.id, 'pre-processing')).map((r) => r.id)).toEqual([pre2.id, pre1b.id]);
  });
});
