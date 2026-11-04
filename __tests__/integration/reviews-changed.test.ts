import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changedSinceSeal, listStageReviews } from '@/lib/data/reviews';
import { checkSeal, sealStageReview } from '@/lib/data/seals';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { markerText } from '../helpers/markers';
import { addDecision, addFinding, addMitigationVersion, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type FixtureDecision, type OrgFixture } from '../helpers/recordFixture';

/** FR-REV-05 (and FR-REV-06 after a racing save): "changed since seal N" by row ids, never by time. */

// One test commits a decision version on another connection after the seal builder has read its rows and before it
// inserts the seal: the hook runs once, after the real readStageRows returns, then is cleared.
const race = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));
vi.mock('@/lib/seal/manifest', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/seal/manifest')>();
  return {
    ...real,
    readStageRows: async (...args: Parameters<typeof real.readStageRows>) => {
      const rows = await real.readStageRows(...args);
      const hook = race.after;
      race.after = null;
      if (hook) await hook();
      return rows;
    },
  };
});

let fx: OrgFixture;
let p: { id: string };
let r: { id: string };
let fv: string;
let f1: { id: string };
const ctx = () => ctxFor(fx, 'viewer');
const dec = (questionId: string, contentVersionId = fv): FixtureDecision =>
  ({ stage: 'pre-processing', questionId, contentVersionId, declaredDate: '2026-10-20' });

async function seal(reviewId: string) {
  const out = await sealStageReview(ctxFor(fx, 'reviewer'), { userId: fx.members.reviewer.userId, role: 'reviewer' },
    { requestId: randomUUID(), projectId: p.id, reviewId }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  return out.value;
}

beforeEach(async () => {
  race.after = null;
  await resetDb();
  fv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
  await addDecision(fx, p.id, dec('Q-PP-01'));
  await addDecision(fx, p.id, dec('Q-PP-02'));
  f1 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('changedSinceSeal', () => {
  it('FR-REV-05: never sealed reads null', async () => {
    expect(await changedSinceSeal(ctx(), r.id)).toBeNull();
  });

  it('FR-REV-05: a new version after seal 1 reads changed since seal 1 naming that question; sealing again leaves seal 1 unchanged', async () => {
    const s1 = await seal(r.id);
    expect(await changedSinceSeal(ctx(), r.id)).toBeNull();
    await addDecision(fx, p.id, dec('Q-PP-01'));
    expect(await changedSinceSeal(ctx(), r.id)).toEqual({ sealNumber: 1, changedQuestions: ['Q-PP-01'], changedFindings: [] });
    const before = await testDb.seal.findUniqueOrThrow({ where: { id: s1.id } });
    const s2 = await seal(r.id);
    expect(s2.sealNumber).toBe(2);
    expect(await testDb.seal.findUniqueOrThrow({ where: { id: s1.id } })).toEqual(before);
    expect(await changedSinceSeal(ctx(), r.id)).toBeNull();
  });

  it('FR-REV-05: a finding event or a mitigation version after the seal names that finding', async () => {
    await seal(r.id);
    await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-20' });
    expect(await changedSinceSeal(ctx(), r.id)).toEqual({ sealNumber: 1, changedQuestions: [], changedFindings: [f1.id] });
    const f2 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    expect((await changedSinceSeal(ctx(), r.id))!.changedFindings).toEqual([f1.id, f2.id].sort());
  });

  it('FR-REV-05 FR-REV-06: a decision version committed between a seal snapshot and its insert shows changed since seal 1, and the check of seal 1 passes', async () => {
    race.after = async () => { await addDecision(fx, p.id, dec('Q-PP-02')); };   // testDb: another connection, committed at once
    const s1 = await seal(r.id);
    expect(race.after).toBeNull();
    expect((await testDb.decisionVersion.count({ where: { projectId: p.id, questionId: 'Q-PP-02' } }))).toBe(2);
    expect((await changedSinceSeal(ctx(), r.id))!.changedQuestions).toEqual(['Q-PP-02']);
    expect((await checkSeal(ctx(), s1.id)).kind).toBe('valid');
  });

  it('FR-REV-05: only the content version changing leaves the row ids, so the review is not changed, and the seal keeps its own content version', async () => {
    await seal(r.id);
    await useFixtureContent('0.0.2-fixture');   // same questions and gates, reworded texts (fixture diff)
    expect(await changedSinceSeal(ctx(), r.id)).toBeNull();
    const [v] = await listStageReviews(ctx(), p.id, 'pre-processing');
    expect([v.latestSeal!.contentSemver, v.changedSinceLatestSeal, v.changed]).toEqual(['0.0.1-fixture', false, null]);
  });

  it('FR-REV-05: "changed since" is never decided by time', () => {
    const src = readFileSync('lib/data/reviews.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function changedSinceSeal'), src.indexOf('\n}\n', src.indexOf('export async function changedSinceSeal')));
    const helper = src.slice(src.indexOf('function idSetChange'), src.indexOf('\n}\n', src.indexOf('function idSetChange')));
    expect(body.length).toBeGreaterThan(200);
    expect(helper.length).toBeGreaterThan(200);
    for (const code of [body, helper]) expect(code).not.toMatch(/receivedAt|sealedAt|openedAt|raisedAt|issuedAt|\bat\b\s*[<>]|Date|getTime/);
  });

  it('FR-REV-05 (helper): listStageReviews carries the latest seal and the change', async () => {
    await seal(r.id); await addDecision(fx, p.id, dec('Q-PP-01'));
    const [v] = await listStageReviews(ctx(), p.id, 'pre-processing');
    expect([v.latestSeal!.sealNumber, v.changedSinceLatestSeal, v.changed!.changedQuestions]).toEqual([1, true, ['Q-PP-01']]);
    const r2 = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    const views = await listStageReviews(ctx(), p.id, 'pre-processing');
    expect(views.find((x) => x.id === r2.id)).toMatchObject({ latestSeal: null, changedSinceLatestSeal: false, changed: null });
  });

  it('FR-REV-05 (C4 CR-2 ruling): a current decision on a question the running content no longer holds reads changed, naming it, and nothing throws', async () => {
    await seal(r.id);
    // The state a content version that cuts a decided question leaves: a current decision whose question the running
    // content does not hold (written as the database owner; no content of H0's bundle cuts a question).
    await addDecision(fx, p.id, dec('Q-PP-99'));
    expect(await changedSinceSeal(ctx(), r.id)).toEqual({ sealNumber: 1, changedQuestions: ['Q-PP-99'], changedFindings: [] });
    const [v] = await listStageReviews(ctx(), p.id, 'pre-processing');
    expect([v.changedSinceLatestSeal, v.changed!.changedQuestions]).toEqual([true, ['Q-PP-99']]);
    await addDecision(fx, p.id, dec('Q-PP-01'));   // a real change alongside it is still found
    expect((await changedSinceSeal(ctx(), r.id))!.changedQuestions).toEqual(['Q-PP-01', 'Q-PP-99']);
  });

  it('FR-REV-06 (C4 SF-1 ruling): a latest seal holding another seal\'s bytes and fingerprint is flagged unreadable, and bytesMatch keeps its meaning', async () => {
    const s1 = await seal(r.id);
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: s1.id } });
    await addSealRow(fx, r.id, { manifest: Buffer.from(row.manifest), contentVersionId: row.contentVersionId });   // seal 2: seal 1's bytes, their SHA-256
    const [v] = await listStageReviews(ctx(), p.id, 'pre-processing');
    expect([v.latestSeal!.sealNumber, v.latestSeal!.bytesMatch, v.latestSealUnreadable]).toEqual([2, true, true]);
    expect(await changedSinceSeal(ctx(), r.id)).toBeNull();
    const fresh = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    await seal(fresh.id);
    expect((await listStageReviews(ctx(), p.id, 'pre-processing')).find((x) => x.id === fresh.id)!.latestSealUnreadable).toBe(false);
  });
});
