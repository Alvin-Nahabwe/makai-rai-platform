import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { loadNextStep } from '@/lib/home/load';
import { openQuestionIds, stageView } from '@/lib/data/projects';
import { currentDecisionRows } from '@/lib/data/decisions';
import { withOrg } from '@/lib/data/tenant';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { loadQuestionPanel } from '@/lib/question/panel';
import { STAGES } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type FixtureDecision, type OrgFixture } from '../helpers/recordFixture';

/**
 * Plan 1B Task 9 (slice 3): `loadNextStep`, Home's "Your next step" for a person who records (rule C2). Records come from
 * the record fixture builder; the loader runs as the app role, under row-level security. Content: 0.0.1-fixture.
 */
let fx: OrgFixture;
let cv: string;
const PP = 'pre-processing' as const;
const IP = 'in-processing' as const;
const today = '2026-11-14';

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ label: 'a' });
});

const save = (f: OrgFixture, projectId: string, d: Omit<FixtureDecision, 'contentVersionId'>) =>
  addDecision(f, projectId, { status: 'done', ...d, contentVersionId: cv });
const next = (role: OrgRole, f: OrgFixture = fx) => loadNextStep(ctxFor(f, role), f.members[role].userId);
const ids = (stage: typeof PP | typeof IP) => questionsInStage(runningContent(), stage).map((q) => q.id);

describe('loadNextStep', () => {
  it("Review Focus 2: a member of A and B who saved in B after A gets A's project under A and B's under B", async () => {
    const b = await buildOrg({ label: 'b' });
    const u = fx.members.assessor;
    await testDb.membership.create({ data: { orgId: b.org.id, userId: u.userId, role: 'assessor' } });
    const asUInB: OrgFixture = { ...b, members: { ...b.members, assessor: { ...u, orgId: b.org.id, orgSlug: b.org.slug } } };
    const pa = await addProject(fx, { name: 'Alpha project of A' });
    const pb = await addProject(b, { name: 'Beta project of B' });
    await save(fx, pa.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(asUInB, pb.id, { stage: IP, questionId: 'Q-IP-01' });
    const inA = await loadNextStep(ctxFor(fx, 'assessor'), u.userId);
    const inB = await loadNextStep(ctxFor(b, 'assessor'), u.userId);
    expect(inA).toMatchObject({ projectId: pa.id, projectName: 'Alpha project of A', stage: PP });
    expect(inB).toMatchObject({ projectId: pb.id, projectName: 'Beta project of B', stage: IP });
    expect(JSON.stringify(inA)).not.toContain(pb.id);
    expect(JSON.stringify(inA)).not.toContain('Beta project of B');
    expect(JSON.stringify(inB)).not.toContain(pa.id);
    expect(JSON.stringify(inB)).not.toContain('Alpha project of A');
  });

  it('T9.5: a viewer and a reviewer get null, also when rows exist that they did not enter', async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-02', by: 'owner' });
    expect(await next('viewer')).toBeNull();
    expect(await next('reviewer')).toBeNull();
    // Even versions entered under their own id (a role changed since) give a Reviewer or Viewer no next step.
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-03', by: 'viewer' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-04', by: 'reviewer' });
    expect(await next('viewer')).toBeNull();
    expect(await next('reviewer')).toBeNull();
  });

  it('an owner and an admin with no saved entry get null', async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    expect(await next('owner')).toBeNull();
    expect(await next('admin')).toBeNull();
  });

  it('an assessor with no saved entry gets first-open in Pre-processing of the most recently updated active project', async () => {
    const older = await addProject(fx, { name: 'Older' });
    const newer = await addProject(fx, { name: 'Newer' });
    const archived = await addProject(fx, { name: 'Archived', archived: true });
    await save(fx, newer.id, { stage: PP, questionId: ids(PP)[0], by: 'owner' });
    await testDb.project.update({ where: { id: older.id }, data: { name: 'Older, renamed last' } });
    await testDb.project.update({ where: { id: archived.id }, data: { name: 'Archived, renamed after' } });
    expect(await next('assessor')).toEqual({
      projectId: older.id, projectName: 'Older, renamed last', stage: PP, questionId: ids(PP)[0],
      questionText: runningContent().questions.get(ids(PP)[0])?.text, position: { n: 1, of: expect.any(Number) },
      rule: 'first-open', lastSavedOn: null,
    });
    await testDb.project.update({ where: { id: newer.id }, data: { name: 'Newer, renamed' } });
    expect(await next('assessor')).toMatchObject({ projectId: newer.id, questionId: ids(PP)[1], position: { n: 2 }, rule: 'first-open' });
  });

  it('an assessor with no saved entry and no active project gets null', async () => {
    await addProject(fx, { archived: true });
    expect(await next('assessor')).toBeNull();
  });

  it('next-open: the next question with no decision after the last-saved one, wrapping round', async () => {
    const p = await addProject(fx, { name: 'P' });
    const q = ids(IP);
    await save(fx, p.id, { stage: IP, questionId: q[1], by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[0] });
    const saved = await testDb.decisionVersion.findFirstOrThrow({ where: { projectId: p.id, questionId: q[0] } });
    expect(await next('assessor')).toMatchObject({
      projectId: p.id, stage: IP, questionId: q[2], position: { n: 3, of: q.length }, rule: 'next-open', lastSavedOn: saved.receivedAt.toISOString(),
    });
    // Every question after the last-saved one decided, and q[1] withdrawn: it wraps round to q[1], open again.
    for (const id of q.slice(2)) await save(fx, p.id, { stage: IP, questionId: id, by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[1], status: 'withdrawn', withdrawalCode: 'entered_in_error', by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[q.length - 1] });
    expect(await next('assessor')).toMatchObject({ questionId: q[1], position: { n: 2, of: q.length }, rule: 'next-open' });
  });

  it('last-saved: a stage with no question open gives the last-saved question itself', async () => {
    const p = await addProject(fx);
    const q = ids(IP);
    for (const id of q) await save(fx, p.id, { stage: IP, questionId: id, by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[4] });
    expect(await next('assessor')).toMatchObject({ questionId: q[4], position: { n: 5, of: q.length }, rule: 'last-saved' });
  });

  it("openQuestionIds counts the same as stageView's noDecision, per stage (one rule)", async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-02', status: 'not_yet' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-03' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-03', status: 'withdrawn', withdrawalCode: 'entered_in_error' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-GATE-SENSITIVE', status: null, scopeAnswer: 'no' });
    await save(fx, p.id, { stage: IP, questionId: 'Q-IP-01', status: 'partly' });
    const content = runningContent();
    const counts = await stageView(ctxFor(fx, 'owner'), p.id, today);
    for (const stage of STAGES) {
      const rows = await withOrg(ctxFor(fx, 'owner'), (tx) => currentDecisionRows(tx, p.id, stage));
      const open = openQuestionIds({ questions: questionsInStage(content, stage), current: new Map(rows.map((r) => [r.questionId, r])),
        applies: (id, gate) => questionApplies(content, id, gate) });
      expect(open.size, stage).toBe(counts[stage].noDecision);
    }
  });

  it("position equals the question page's position for the same question (Question n of m)", async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-GATE-SENSITIVE', status: null, scopeAnswer: 'no', by: 'owner' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-12' });
    const step = await next('assessor');
    expect(step).not.toBeNull();
    const identity = { userId: fx.members.assessor.userId, email: fx.members.assessor.email, name: fx.members.assessor.name, platformRole: 'assessor' as const, mustChangePassword: false };
    const panel = await loadQuestionPanel(ctxFor(fx, 'assessor'), identity, { projectId: p.id, stage: PP, questionId: step!.questionId });
    expect(step!.position).toEqual({ n: panel.position.index + 1, of: panel.position.total });
    expect(step!.questionText).toBe(panel.runningQuestion.text);
  });

  it('a save in an archived project is ignored', async () => {
    const active = await addProject(fx, { name: 'Active' });
    const archived = await addProject(fx, { name: 'Archived' });
    await save(fx, active.id, { stage: PP, questionId: 'Q-PP-05' });
    await save(fx, archived.id, { stage: IP, questionId: 'Q-IP-05' });
    await testDb.project.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    expect(await next('assessor')).toMatchObject({ projectId: active.id, stage: PP, rule: 'next-open' });
  });
});
