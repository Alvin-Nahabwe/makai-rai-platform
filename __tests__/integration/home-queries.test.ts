import { beforeEach, describe, expect, it } from 'vitest';
import { lastSavedBy } from '@/lib/home/queries';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

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
