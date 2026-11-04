import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { myMitigations, openMitigationsByStage, ownerCannotAct, stageFollowUpCounts } from '../../lib/data/followup';

/**
 * FR-FUP-01, 02, 05: the follow-up lists the pages show. Fixtures go through the record fixture
 * builder (testDb); the services under test run in `withOrg`, so row-level security applies.
 */

const TODAY = '2026-11-02';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await resetDb(); });

/** Membership changes the way MEM does: the row goes, and a member_removed event names the member. */
async function removeMember(fx: OrgFixture, role: OrgRole): Promise<void> {
  const userId = fx.members[role].userId;
  await testDb.membership.deleteMany({ where: { orgId: fx.org.id, userId } });
  await testDb.$executeRaw`
    INSERT INTO "organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetUserId")
    VALUES (gen_random_uuid()::text, ${fx.org.id}, ${fx.members.owner.userId}, 'owner', 'member_removed', ${userId})`;
}
async function setRole(fx: OrgFixture, role: OrgRole, to: OrgRole): Promise<void> {
  const userId = fx.members[role].userId;
  await testDb.membership.updateMany({ where: { orgId: fx.org.id, userId }, data: { role: to } });
  await testDb.$executeRaw`
    INSERT INTO "organisation_events" ("id", "orgId", "actorId", "actorRole", "action", "targetUserId", "previousValue")
    VALUES (gen_random_uuid()::text, ${fx.org.id}, ${fx.members.owner.userId}, 'owner', 'member_role_changed', ${userId}, ${role})`;
}

async function threeDueDates() {
  const fx = await buildOrg({ label: 'fl' });
  const p = await addProject(fx);
  const f1 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  const f2 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-09' });
  await addMitigationVersion(fx, f1.id, { status: 'in_progress', owner: 'assessor', dueDate: '2026-11-01' });
  await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'admin', dueDate: '2026-11-02' });
  return { fx, p, f1, f2 };
}

describe('follow-up services', () => {
  it('FR-FUP-01: S-10 lists a stage\'s mitigations overdue first, then by due date', async () => {
    const { fx, p } = await threeDueDates();
    const lists = await openMitigationsByStage(ctxFor(fx, 'viewer'), p.id, TODAY);
    expect(lists['pre-processing'].map((i) => [i.dueDate, i.overdue])).toEqual([['2026-11-01', true], ['2026-11-02', false], ['2026-11-09', false]]);
    expect(lists['in-processing']).toEqual([]);
    expect(lists['pre-processing'][0]).toMatchObject({ status: 'in_progress', ownerCanAct: true, owner: { userId: fx.members.assessor.userId } });
    expect(typeof lists['pre-processing'][0].what).toBe('string');
  });

  it('FR-FUP-05: a removed owner and an owner changed to viewer are both "owner cannot act"', async () => {
    const fx = await buildOrg({ label: 'fc' });
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const mRemoved = (await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'admin', dueDate: '2026-11-05' })).mitigationId;
    const mLowered = (await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-06' })).mitigationId;
    const mFine = (await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'owner', dueDate: '2026-11-07' })).mitigationId;
    await removeMember(fx, 'admin'); await setRole(fx, 'assessor', 'viewer');
    const cannot = await ownerCannotAct(ctxFor(fx, 'owner'), p.id);
    expect(cannot.map((i) => i.mitigationId).sort()).toEqual([mRemoved, mLowered].sort());
    expect(cannot.every((i) => !i.ownerCanAct)).toBe(true);
    expect(cannot.find((i) => i.mitigationId === mRemoved)!.owner.formerMember).toBe(true);
    const all = await openMitigationsByStage(ctxFor(fx, 'owner'), p.id, TODAY);
    expect(all['pre-processing'].find((i) => i.mitigationId === mFine)!.ownerCanAct).toBe(true);
  });

  it('FR-FUP-05: a deactivated owner is "owner cannot act"', async () => {
    const fx = await buildOrg({ label: 'fd' });
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const m = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-05' });
    await testDb.user.update({ where: { id: fx.members.assessor.userId }, data: { isActive: false } });
    expect((await ownerCannotAct(ctxFor(fx, 'owner'), p.id)).map((i) => i.mitigationId)).toEqual([m.mitigationId]);
  });

  it('FR-FUP-01 FR-FUP-02: S-11 and S-08 counts: open findings and overdue mitigations of one stage', async () => {
    const { fx, p } = await threeDueDates();
    const closed = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addAcceptedRisk(fx, closed.id, {});
    expect(await stageFollowUpCounts(ctxFor(fx, 'viewer'), p.id, 'pre-processing', TODAY)).toEqual({ openFindings: 2, overdueMitigations: 1 });
    expect(await stageFollowUpCounts(ctxFor(fx, 'viewer'), p.id, 'in-processing', TODAY)).toEqual({ openFindings: 0, overdueMitigations: 0 });
  });

  it('FR-FUP-01 FR-PRJ-03: myMitigations lists the person\'s own open items and none of an archived project', async () => {
    const { fx, p } = await threeDueDates();
    const archived = await addProject(fx, { archived: true });
    const fa = await addFinding(fx, archived.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, fa.id, { status: 'planned', owner: 'admin', dueDate: '2026-11-01' });
    const mine = await myMitigations(ctxFor(fx, 'admin'), fx.members.admin.userId, TODAY);
    expect(mine.map((i) => i.projectId)).toEqual([p.id]);
    expect(mine.every((i) => i.owner.userId === fx.members.admin.userId)).toBe(true);
    expect(mine.some((i) => i.projectId === archived.id)).toBe(false);
  });

  it('NFR-SEC-02 FR-FUP-01: follow-up lists show only the context organisation\'s mitigations', async () => {
    const { fx, p } = await threeDueDates();
    const fxB = await buildOrg({ label: 'fb' });
    expect(await myMitigations(ctxFor(fxB, 'admin'), fx.members.admin.userId, TODAY)).toEqual([]);
    expect((await openMitigationsByStage(ctxFor(fxB, 'owner'), p.id, TODAY))['pre-processing']).toEqual([]);
  });
});
