import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { changesSince, lastSavedBy, lastSavedIn } from '@/lib/home/queries';
import type { Stage } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { withTriggersDisabled } from '../helpers/triggers';
import { addDecision, addFinding, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * Plan 1B Task 9 (slice 3): `lastSavedBy`, the person's newest saved entry in an active project of the organisation.
 * Records come from the record fixture builder; the query runs as the app role, under row-level security.
 */
let fx: OrgFixture;
let cv: string;
const stage = 'pre-processing' as const;

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ label: 'a' });
});

describe('lastSavedBy', () => {
  it("returns the newest of the person's own versions", async () => {
    const p = await addProject(fx, { name: 'Active project' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage: 'in-processing', questionId: 'Q-IP-01', contentVersionId: cv, status: 'partly' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'not_yet' });
    const saved = await lastSavedBy(ctxFor(fx, 'assessor'), fx.members.assessor.userId);
    expect(saved).toMatchObject({ projectId: p.id, projectName: 'Active project', stage, questionId: 'Q-PP-01' });
    const newest = await testDb.decisionVersion.findFirstOrThrow({ where: { projectId: p.id, questionId: 'Q-PP-01', versionNumber: 2 } });
    expect(saved?.at).toBe(newest.receivedAt.toISOString());
  });

  it("ignores other people's versions", async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done', by: 'owner' });
    expect(await lastSavedBy(ctxFor(fx, 'assessor'), fx.members.assessor.userId)).toMatchObject({ questionId: 'Q-PP-01' });
    expect(await lastSavedBy(ctxFor(fx, 'owner'), fx.members.owner.userId)).toMatchObject({ questionId: 'Q-PP-02' });
  });

  it('ignores an archived project and returns the newest save in an active one instead', async () => {
    const active = await addProject(fx, { name: 'Active' });
    const archived = await addProject(fx, { name: 'Archived' });
    await addDecision(fx, active.id, { stage, questionId: 'Q-PP-03', contentVersionId: cv, status: 'done' });
    await addDecision(fx, archived.id, { stage, questionId: 'Q-PP-04', contentVersionId: cv, status: 'done' });
    await testDb.project.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    expect(await lastSavedBy(ctxFor(fx, 'assessor'), fx.members.assessor.userId)).toMatchObject({ projectId: active.id, questionId: 'Q-PP-03' });
  });

  it('counts a withdrawn decision as a saved change', async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
    expect(await lastSavedBy(ctxFor(fx, 'assessor'), fx.members.assessor.userId)).toMatchObject({ questionId: 'Q-PP-01' });
  });

  it('is null for a person who never saved', async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    expect(await lastSavedBy(ctxFor(fx, 'admin'), fx.members.admin.userId)).toBeNull();
  });

  it("under ctx A, a member of A and B who saved in B after A gets A's row", async () => {
    const b = await buildOrg({ label: 'b' });
    const u = fx.members.assessor;
    await testDb.membership.create({ data: { orgId: b.org.id, userId: u.userId, role: 'assessor' } });
    const asUInB: OrgFixture = { ...b, members: { ...b.members, assessor: { ...u, orgId: b.org.id, orgSlug: b.org.slug } } };
    const pa = await addProject(fx, { name: 'Project in A' });
    const pb = await addProject(b, { name: 'Project in B' });
    await addDecision(fx, pa.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(asUInB, pb.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
    expect(await lastSavedBy(ctxFor(fx, 'assessor'), u.userId)).toMatchObject({ projectId: pa.id, projectName: 'Project in A', questionId: 'Q-PP-01' });
    expect(await lastSavedBy(ctxFor(b, 'assessor'), u.userId)).toMatchObject({ projectId: pb.id, projectName: 'Project in B', questionId: 'Q-PP-02' });
  });
});

/** Plan 1C C11 (cut), case at plan line 368: `lastSavedIn`, the lastSavedBy rule for one project. */
describe('lastSavedIn', () => {
  it('returns the newest version the viewer entered in this project, a withdrawal included', async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage: 'in-processing', questionId: 'Q-IP-01', contentVersionId: cv, status: 'done' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), p.id, fx.members.assessor.userId)).toEqual({ stage: 'in-processing', questionId: 'Q-IP-01' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), p.id, fx.members.assessor.userId)).toEqual({ stage, questionId: 'Q-PP-01' });
  });

  it("ignores another member's newer save in the project", async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done', by: 'owner' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), p.id, fx.members.assessor.userId)).toEqual({ stage, questionId: 'Q-PP-01' });
  });

  it("ignores the viewer's newer save in another project", async () => {
    const p = await addProject(fx, { name: 'This' });
    const other = await addProject(fx, { name: 'Other' });
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
    await addDecision(fx, other.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), p.id, fx.members.assessor.userId)).toEqual({ stage, questionId: 'Q-PP-01' });
  });

  it('is null when the viewer saved nothing in the project', async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done', by: 'owner' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), p.id, fx.members.assessor.userId)).toBeNull();
  });

  it("under ctx A, the id of B's project where the same person (a member of both) saved gives null", async () => {
    const b = await buildOrg({ label: 'b' });
    const u = fx.members.assessor;
    await testDb.membership.create({ data: { orgId: b.org.id, userId: u.userId, role: 'assessor' } });
    const asUInB: OrgFixture = { ...b, members: { ...b.members, assessor: { ...u, orgId: b.org.id, orgSlug: b.org.slug } } };
    const pb = await addProject(b, { name: 'Project in B' });
    await addDecision(asUInB, pb.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
    expect(await lastSavedIn(ctxFor(fx, 'assessor'), pb.id, u.userId)).toBeNull();
    expect(await lastSavedIn(ctxFor(b, 'assessor'), pb.id, u.userId)).toEqual({ stage, questionId: 'Q-PP-02' });
  });
});

/**
 * Plan 1B Task 9 (the rest): `changesSince`, the saved changes of the organisation after a time, grouped by day, person,
 * kind, project and stage, newest first, capped with `more`. A change's time is the database's, so a case that needs
 * changes on given days moves each row's time column with its refusal trigger off (test set-up only, as `makrai`).
 */
describe('changesSince', () => {
  const TIME_COLUMN = { decision_versions: 'receivedAt', findings: 'raisedAt', seals: 'sealedAt' } as const;
  async function timeOf(table: keyof typeof TIME_COLUMN, id: string, when: string): Promise<void> {
    await withTriggersDisabled(table, () => testDb.$executeRawUnsafe(
      `UPDATE "${table}" SET "${TIME_COLUMN[table]}" = $1::timestamptz WHERE "id" = $2`, when, id), [`${table}_refuse_row`]);
  }
  const decideAt = async (f: OrgFixture, projectId: string, when: string, d: { stage?: Stage; questionId: string; by?: OrgRole; status?: 'done' | 'withdrawn' }) => {
    const row = await addDecision(f, projectId, {
      stage: d.stage ?? stage, questionId: d.questionId, contentVersionId: cv, status: d.status ?? 'done', by: d.by,
      ...(d.status === 'withdrawn' ? { withdrawalCode: 'entered_in_error' } : {}),
    });
    await timeOf('decision_versions', row.id, when);
    return row;
  };
  const since = new Date('2026-11-05T00:00:00Z');
  const all = (f: OrgFixture = fx, opts: Partial<{ since: Date; excludeUserId: string | null; limitGroups: number }> = {}) =>
    changesSince(ctxFor(f, 'viewer'), { since, excludeUserId: null, limitGroups: 10, ...opts });

  it('groups by day, person, kind, project and stage, newest first, with the latest time and the number of things changed', async () => {
    const alpha = await addProject(fx, { name: 'Alpha' });
    const beta = await addProject(fx, { name: 'Beta' });
    await decideAt(fx, alpha.id, '2026-11-01T09:00:00Z', { questionId: 'Q-PP-06' });            // before `since`: not a change
    await decideAt(fx, alpha.id, '2026-11-10T22:30:00Z', { questionId: 'Q-PP-05' });            // 01:30 on 11 Nov in EAT
    await decideAt(fx, alpha.id, '2026-11-12T05:00:00Z', { questionId: 'Q-PP-01' });
    await decideAt(fx, alpha.id, '2026-11-12T05:30:00Z', { questionId: 'Q-PP-02' });
    await decideAt(fx, alpha.id, '2026-11-12T05:45:00Z', { questionId: 'Q-PP-01' });            // a second version of Q-PP-01
    await decideAt(fx, alpha.id, '2026-11-12T06:00:00Z', { stage: 'in-processing', questionId: 'Q-IP-01' });
    await decideAt(fx, beta.id, '2026-11-12T07:00:00Z', { questionId: 'Q-PP-03' });
    await decideAt(fx, alpha.id, '2026-11-12T08:00:00Z', { questionId: 'Q-PP-04', by: 'owner' });
    const finding = await addFinding(fx, alpha.id, { stage, source: 'team', by: 'reviewer' });
    await timeOf('findings', finding.id, '2026-11-12T09:00:00Z');
    const review = await addStageReview(fx, alpha.id, { stage: 'post-processing' });
    const seal = await addSealRow(fx, review.id, { by: 'owner' });
    await timeOf('seals', seal.id, '2026-11-12T10:00:00Z');

    const { groups, more } = await all();
    const { owner, assessor, reviewer } = fx.members;
    const ref = (m: typeof owner) => ({ userId: m.userId, name: m.name, formerMember: false });
    const g = (day: string, latestAt: string, who: typeof owner, kind: string, count: number, p: { id: string }, name: string, s: Stage) =>
      ({ day, latestAt, who: ref(who), kind, count, projectId: p.id, projectName: name, stage: s });
    expect(more).toBe(false);
    expect(groups).toEqual([
      g('2026-11-12', '2026-11-12T10:00:00.000Z', owner, 'seal', 1, alpha, 'Alpha', 'post-processing'),
      g('2026-11-12', '2026-11-12T09:00:00.000Z', reviewer, 'finding', 1, alpha, 'Alpha', stage),
      g('2026-11-12', '2026-11-12T08:00:00.000Z', owner, 'decisions', 1, alpha, 'Alpha', stage),
      g('2026-11-12', '2026-11-12T07:00:00.000Z', assessor, 'decisions', 1, beta, 'Beta', stage),
      g('2026-11-12', '2026-11-12T06:00:00.000Z', assessor, 'decisions', 1, alpha, 'Alpha', 'in-processing'),
      // Two questions saved, one of them twice: two decisions.
      g('2026-11-12', '2026-11-12T05:45:00.000Z', assessor, 'decisions', 2, alpha, 'Alpha', stage),
      g('2026-11-11', '2026-11-10T22:30:00.000Z', assessor, 'decisions', 1, alpha, 'Alpha', stage),
    ]);
  });

  it('excludes the reader, and nobody when excludeUserId is null', async () => {
    const p = await addProject(fx);
    await decideAt(fx, p.id, '2026-11-12T05:00:00Z', { questionId: 'Q-PP-01' });
    await decideAt(fx, p.id, '2026-11-12T06:00:00Z', { questionId: 'Q-PP-02', by: 'owner' });
    const mine = await all(fx, { excludeUserId: fx.members.assessor.userId });
    expect(mine.groups.map((x) => x.who.userId)).toEqual([fx.members.owner.userId]);
    expect((await all()).groups.map((x) => x.who.userId)).toEqual([fx.members.owner.userId, fx.members.assessor.userId]);
  });

  it('caps at limitGroups with more=true, and says more=false when the groups fit exactly', async () => {
    for (let i = 0; i < 12; i += 1) {
      const p = await addProject(fx, { name: `Project ${i}` });
      await decideAt(fx, p.id, `2026-11-12T${String(i).padStart(2, '0')}:00:00Z`, { questionId: 'Q-PP-01' });
    }
    const capped = await all();
    expect(capped.groups).toHaveLength(10);
    expect(capped.more).toBe(true);
    expect(capped.groups[0].projectName).toBe('Project 11');
    expect(capped.groups[9].projectName).toBe('Project 2');
    const exact = await all(fx, { limitGroups: 12 });
    expect(exact.groups).toHaveLength(12);
    expect(exact.more).toBe(false);
  });

  it('counts a withdrawn decision as a saved change', async () => {
    const p = await addProject(fx);
    await decideAt(fx, p.id, '2026-11-01T05:00:00Z', { questionId: 'Q-PP-01' });
    await decideAt(fx, p.id, '2026-11-12T05:00:00Z', { questionId: 'Q-PP-01', status: 'withdrawn' });
    expect((await all()).groups).toEqual([expect.objectContaining({ kind: 'decisions', count: 1, projectId: p.id, latestAt: '2026-11-12T05:00:00.000Z' })]);
  });

  it('T9.4: leaves out every change in an archived project, decisions, findings and seals alike', async () => {
    const archived = await addProject(fx, { name: 'Archived', archived: true });
    await decideAt(fx, archived.id, '2026-11-12T05:00:00Z', { questionId: 'Q-PP-01' });
    const finding = await addFinding(fx, archived.id, { stage, source: 'team', by: 'reviewer' });
    await timeOf('findings', finding.id, '2026-11-12T06:00:00Z');
    const review = await addStageReview(fx, archived.id, { stage });
    const seal = await addSealRow(fx, review.id);
    await timeOf('seals', seal.id, '2026-11-12T07:00:00Z');
    expect(await all()).toEqual({ groups: [], more: false });
  });

  it('a change at the very time `since` names is not after it', async () => {
    const p = await addProject(fx);
    await decideAt(fx, p.id, since.toISOString(), { questionId: 'Q-PP-01' });
    expect((await all()).groups).toEqual([]);
  });

  it('T9.3: names each person by their account through userRefs, with the former-member mark for someone removed', async () => {
    const p = await addProject(fx);
    await decideAt(fx, p.id, '2026-11-12T05:00:00Z', { questionId: 'Q-PP-01' });
    await testDb.membership.deleteMany({ where: { orgId: fx.org.id, userId: fx.members.assessor.userId } });
    await testDb.$executeRaw`
      INSERT INTO "organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetUserId")
      VALUES (gen_random_uuid()::text, ${fx.org.id}, ${fx.members.owner.userId}, 'owner', 'member_removed', ${fx.members.assessor.userId})`;
    expect((await all()).groups[0].who).toEqual({ userId: fx.members.assessor.userId, name: fx.members.assessor.name, formerMember: true });
  });

  it('refuses a cap below one and a time that is not one, rather than reading nothing', async () => {
    await expect(all(fx, { limitGroups: 0 })).rejects.toThrow(RangeError);
    await expect(all(fx, { limitGroups: 1.5 })).rejects.toThrow(RangeError);
    await expect(all(fx, { since: new Date('not a date') })).rejects.toThrow(RangeError);
  });
});
