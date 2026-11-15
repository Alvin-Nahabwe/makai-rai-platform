import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { loadContinueTarget, loadHome, loadNextStep } from '@/lib/home/load';
import { lastSavedBy } from '@/lib/home/queries';
import { openQuestionIds, stageView } from '@/lib/data/projects';
import { currentDecisionRows } from '@/lib/data/decisions';
import { withOrg } from '@/lib/data/tenant';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { loadQuestionPanel } from '@/lib/question/panel';
import { STAGES, type Stage } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { withTriggersDisabled } from '../helpers/triggers';
import { sealFixture } from '../helpers/sealFixture';
import { addDecision, addFinding, addFindingEvent, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor, type FixtureDecision, type OrgFixture } from '../helpers/recordFixture';

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
const ids = (stage: Stage) => questionsInStage(runningContent(), stage).map((q) => q.id);

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

  it('F1: an assessor whose only saves are in a project archived since gets null, not first-open', async () => {
    const active = await addProject(fx, { name: 'Active' });
    const archived = await addProject(fx, { name: 'Archived since' });
    await save(fx, archived.id, { stage: PP, questionId: 'Q-PP-01' });
    await testDb.project.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    expect(await next('assessor')).toBeNull();
    // Another assessor of the same organisation, who never saved, still gets first-open in the active project.
    await testDb.membership.update({ where: { orgId_userId: { orgId: fx.org.id, userId: fx.members.admin.userId } }, data: { role: 'assessor' } });
    expect(await loadNextStep(ctxFor(fx, 'assessor'), fx.members.admin.userId)).toMatchObject({ projectId: active.id, rule: 'first-open' });
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

/** Plan 1C C11 (cut), step 3: `loadContinueTarget`, the project page's primary action, on Home's rule. */
describe('loadContinueTarget', () => {
  const target = (role: OrgRole, p: { id: string; archived?: boolean }, f: OrgFixture = fx) =>
    loadContinueTarget(ctxFor(f, role), f.members[role].userId, { id: p.id, archived: p.archived ?? false });

  it('S4: a Reviewer and a Viewer get null, also when rows exist, their own included', async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-03', by: 'viewer' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-04', by: 'reviewer' });
    expect(await target('viewer', p)).toBeNull();
    expect(await target('reviewer', p)).toBeNull();
    expect(await target('assessor', p)).not.toBeNull();
  });

  it('S4: an archived project gives null, whatever rows exist', async () => {
    const p = await addProject(fx, { archived: true });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    for (const role of ['owner', 'admin', 'assessor'] as const) expect(await target(role, { id: p.id, archived: true })).toBeNull();
  });

  it('no save: start, with the first open question of the first stage that has one', async () => {
    const p = await addProject(fx);
    expect(await target('owner', p)).toEqual({ stage: PP, questionId: ids(PP)[0], label: 'start' });
    // Pre-processing fully decided by the team: the first open question of In-processing.
    for (const id of ids(PP)) await save(fx, p.id, { stage: PP, questionId: id, by: 'assessor', status: id === 'Q-PP-GATE-SENSITIVE' ? null : 'done', ...(id === 'Q-PP-GATE-SENSITIVE' ? { scopeAnswer: 'yes' } : {}) });
    expect(await target('owner', p)).toEqual({ stage: IP, questionId: ids(IP)[0], label: 'start' });
  });

  it('a save: continue, with the next open question after it, wrapping round', async () => {
    const p = await addProject(fx);
    const q = ids(IP);
    await save(fx, p.id, { stage: IP, questionId: q[1], by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[0] });
    expect(await target('assessor', p)).toEqual({ stage: IP, questionId: q[2], label: 'continue' });
    for (const id of q.slice(2)) await save(fx, p.id, { stage: IP, questionId: id, by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[1], status: 'withdrawn', withdrawalCode: 'entered_in_error', by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[q.length - 1] });
    expect(await target('assessor', p)).toEqual({ stage: IP, questionId: q[1], label: 'continue' });
  });

  it('a fully decided stage gives the last-saved question', async () => {
    const p = await addProject(fx);
    const q = ids(IP);
    for (const id of q) await save(fx, p.id, { stage: IP, questionId: id, by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[4] });
    expect(await target('assessor', p)).toEqual({ stage: IP, questionId: q[4], label: 'continue' });
  });

  it("another member's saves do not move the viewer's target but do close questions", async () => {
    const p = await addProject(fx);
    const q = ids(IP);
    await save(fx, p.id, { stage: IP, questionId: q[0] });
    await save(fx, p.id, { stage: PP, questionId: ids(PP)[3], by: 'owner' });
    expect(await target('assessor', p)).toEqual({ stage: IP, questionId: q[1], label: 'continue' });
    await save(fx, p.id, { stage: IP, questionId: q[1], by: 'owner' });
    expect(await target('assessor', p)).toEqual({ stage: IP, questionId: q[2], label: 'continue' });
  });

  it('M1: for a person whose newest save is in this project, loadNextStep and loadContinueTarget name the same stage and question', async () => {
    const p = await addProject(fx);
    const q = ids(IP);
    await save(fx, p.id, { stage: IP, questionId: q[2], by: 'owner' });
    await save(fx, p.id, { stage: IP, questionId: q[1] });
    const home = await next('assessor');
    const page = await target('assessor', p);
    expect(page).toEqual({ stage: home?.stage, questionId: home?.questionId, label: 'continue' });
    expect(home).toMatchObject({ projectId: p.id, stage: IP, questionId: q[3] });
  });
});

/**
 * Plan 1B Task 9 (the rest): `loadHome`, Home's data for every role and state (spec 9.1), the variant chosen in review
 * M13's order from `ctx.role`. Records come from the record fixture builder; the loader runs as the app role.
 */
describe('loadHome', () => {
  const now = new Date();
  const home = (role: OrgRole, f: OrgFixture = fx, userId: string = f.members[role].userId, name: string = f.members[role].name) =>
    loadHome(ctxFor(f, role), { userId, name }, { orgSlug: f.org.slug, welcome: false, today, now });
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  async function receivedAt(id: string, when: string): Promise<void> {
    await withTriggersDisabled('decision_versions', () => testDb.$executeRawUnsafe(
      `UPDATE "decision_versions" SET "receivedAt" = $1::timestamptz WHERE "id" = $2`, when, id), ['decision_versions_refuse_row']);
  }
  const href = (f: OrgFixture, projectId: string, stage: Stage, q: string) => `/orgs/${f.org.slug}/projects/${projectId}/stages/${stage}/questions/${q}`;

  it('M13: with no active project, a viewer and a reviewer get first-time with canCreate false; an owner, admin and assessor with canCreate true', async () => {
    await addProject(fx, { name: 'Only archived', archived: true });
    for (const role of ['viewer', 'reviewer'] as const) {
      expect(await home(role), role).toEqual({ variant: 'first-time', base: expect.objectContaining({ role, archivedCount: 1 }), canCreate: false });
    }
    for (const role of ['owner', 'admin', 'assessor'] as const) {
      expect(await home(role), role).toEqual({ variant: 'first-time', base: expect.objectContaining({ role, archivedCount: 1 }), canCreate: true });
    }
  });

  it('the base carries the organisation, the role and the person the page passed, never another id', async () => {
    await addProject(fx, { name: 'Active' });
    await addProject(fx, { name: 'Gone', archived: true });
    const data = await loadHome(ctxFor(fx, 'assessor'), { userId: fx.members.assessor.userId, name: 'Shown name' },
      { orgSlug: fx.org.slug, welcome: true, today, now });
    expect(data.base).toEqual({
      orgSlug: fx.org.slug, orgId: fx.org.id, orgName: fx.org.name, role: 'assessor', userId: fx.members.assessor.userId,
      userName: 'Shown name', welcome: true, archivedCount: 1, projects: [{ id: expect.any(String), name: 'Active' }],
    });
  });

  it('T9.5: a viewer gets variant viewer and a reviewer variant reviewer, with no next step and no recording link', async () => {
    const p = await addProject(fx);
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    // Versions under their own ids (a role changed since) still give no next step.
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-02', by: 'viewer' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-03', by: 'reviewer' });
    const viewer = await home('viewer');
    const reviewer = await home('reviewer');
    expect(viewer.variant).toBe('viewer');
    expect(reviewer.variant).toBe('reviewer');
    for (const data of [viewer, reviewer]) {
      expect('next' in data).toBe(false);
      expect('focus' in data).toBe(false);
      expect(JSON.stringify(data)).not.toMatch(/"current"/);
    }
    // The lead's ruling on Task 2's point 4: a Viewer's stops lead to the question page, which a Viewer reads as the
    // reading view (record:read); none is "current" and nothing records. A Reviewer's Home has no stops at all.
    expect(JSON.stringify(reviewer)).not.toMatch(/"href"|\/questions\//);
    if (viewer.variant !== 'viewer') throw new Error('expected viewer');
    const stops = viewer.open.flatMap((o) => o.stages.flatMap((s) => s.stops));
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) expect(s.href).toBe(`/orgs/${fx.org.slug}/projects/${p.id}/stages/${s.id.startsWith('Q-PP') ? PP : s.id.startsWith('Q-IP') ? IP : 'post-processing'}/questions/${s.id}`);
  });

  it('recorder: the focus is the next step\'s project, its three stages with counts equal to stageView\'s, stops from the kit\'s marks and the next open question of each stage', async () => {
    const other = await addProject(fx, { name: 'Other' });
    const p = await addProject(fx, { name: 'Focus' });
    await save(fx, other.id, { stage: PP, questionId: 'Q-PP-09', by: 'owner' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-GATE-SENSITIVE', status: null, scopeAnswer: 'no', by: 'owner' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-02', status: 'partly' });
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(fx, p.id, { stage: IP, questionId: 'Q-IP-01', by: 'owner' });
    const data = await home('assessor');
    if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
    expect(data.next).toMatchObject({ projectId: p.id, stage: PP, questionId: 'Q-PP-03' });
    expect(data.otherProjects).toBe(1);
    expect(data.lead).toBeNull();
    expect(data.focus?.projectId).toBe(p.id);
    expect(data.focus?.projectName).toBe('Focus');
    expect(data.focus?.stages.map((s) => s.stage)).toEqual([...STAGES]);
    const counts = await stageView(ctxFor(fx, 'assessor'), p.id, today);
    for (const s of data.focus?.stages ?? []) {
      expect({ stage: s.stage, noDecision: s.noDecision, openFindings: s.openFindings, overdueMitigations: s.overdueMitigations }).toEqual({
        stage: s.stage, noDecision: counts[s.stage].noDecision, openFindings: counts[s.stage].openFindings, overdueMitigations: counts[s.stage].overdueMitigations,
      });
      expect(s.stops.map((x) => x.id)).toEqual(ids(s.stage));
    }
    const pre = data.focus?.stages[0];
    const kind = (q: string) => pre?.stops.find((x) => x.id === q);
    expect(kind('Q-PP-01')).toEqual({ id: 'Q-PP-01', kind: 'done', title: runningContent().questions.get('Q-PP-01')?.text, href: href(fx, p.id, PP, 'Q-PP-01'), current: false });
    expect(kind('Q-PP-02')?.kind).toBe('partly');
    expect(kind('Q-PP-GATE-SENSITIVE')).toMatchObject({ kind: 'scope_answered', scopeAnswer: 'no' });
    expect(kind('Q-PP-13')?.kind).toBe('does_not_apply');
    expect(kind('Q-PP-14')?.kind).toBe('does_not_apply');
    expect(kind('Q-PP-03')).toMatchObject({ kind: 'no_decision', current: true });
    expect(data.focus?.stages.flatMap((s) => s.stops).filter((x) => x.current).map((x) => x.id)).toEqual(['Q-PP-03']);
    expect(pre?.tally).toEqual({ done: 1, partly: 1, scope_answered: 1, does_not_apply: 2, no_decision: ids(PP).length - 5, doneNoEvidence: 1 });
    expect(data.focus?.stages.map((s) => s.nextOpen)).toEqual([
      { questionId: 'Q-PP-03', questionText: runningContent().questions.get('Q-PP-03')?.text, position: { n: 3, of: ids(PP).length } },
      { questionId: ids(IP)[1], questionText: runningContent().questions.get(ids(IP)[1])?.text, position: { n: 2, of: ids(IP).length } },
      { questionId: ids('post-processing')[0], questionText: expect.any(String), position: { n: 1, of: ids('post-processing').length } },
    ]);
  });

  it('recorder: "since" starts at the person\'s last saved change and holds the changes of others after it, never their own', async () => {
    const p = await addProject(fx);
    const old = await save(fx, p.id, { stage: PP, questionId: 'Q-PP-05', by: 'owner' });
    await receivedAt(old.id, daysAgo(3));
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    const mine = await testDb.decisionVersion.findFirstOrThrow({ where: { projectId: p.id, questionId: 'Q-PP-01' } });
    await save(fx, p.id, { stage: IP, questionId: 'Q-IP-02', by: 'owner' });
    const data = await home('assessor');
    if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
    expect(data.since?.from).toBe(mine.receivedAt.toISOString());
    expect(data.since?.more).toBe(false);
    expect(data.since?.groups).toEqual([expect.objectContaining({ who: expect.objectContaining({ userId: fx.members.owner.userId }), stage: IP, count: 1 })]);
  });

  it('an owner with no saved entry gets no next step and no "since"; the focus is the most recently updated active project', async () => {
    const older = await addProject(fx, { name: 'Older' });
    const newer = await addProject(fx, { name: 'Newer' });
    await save(fx, older.id, { stage: PP, questionId: 'Q-PP-01' });
    const data = await home('owner');
    if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
    expect(data.next).toBeNull();
    expect(data.since).toBeNull();
    expect(data.focus).toMatchObject({ projectId: newer.id, projectName: 'Newer' });
    expect(data.focus?.stages.flatMap((s) => s.stops).some((x) => x.current)).toBe(false);
    expect(data.otherProjects).toBe(1);
  });

  it('an assessor with no saved entry gets first-open of the most recently updated project, which is also the focus', async () => {
    await addProject(fx, { name: 'Older' });
    const newer = await addProject(fx, { name: 'Newer' });
    const data = await home('assessor');
    if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
    expect(data.next).toMatchObject({ projectId: newer.id, rule: 'first-open', questionId: ids(PP)[0] });
    expect(data.focus?.projectId).toBe(newer.id);
    expect(data.since).toBeNull();
  });

  it('owner and admin lead lists: overdue mitigations and open findings with no mitigation of active projects only; none for an assessor', async () => {
    const p = await addProject(fx, { name: 'Active' });
    const gone = await addProject(fx, { name: 'Archived' });
    const late = await addFinding(fx, p.id, { stage: PP, source: 'team' });
    const lateMitigation = await addMitigationVersion(fx, late.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    const bare = await addFinding(fx, p.id, { stage: IP, source: 'team' });
    const onTime = await addFinding(fx, p.id, { stage: PP, source: 'team' });
    const onTimeMitigation = await addMitigationVersion(fx, onTime.id, { status: 'in_progress', owner: 'assessor', dueDate: '2026-12-01' });
    const withdrawn = await addFinding(fx, p.id, { stage: PP, source: 'team' });
    await addFindingEvent(fx, withdrawn.id, { kind: 'withdrawn' });
    const goneLate = await addFinding(fx, gone.id, { stage: PP, source: 'team' });
    await addMitigationVersion(fx, goneLate.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    await addFinding(fx, gone.id, { stage: PP, source: 'team' });
    await testDb.project.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    for (const role of ['owner', 'admin'] as const) {
      const data = await home(role);
      if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
      expect(data.lead?.overdue.map((m) => m.mitigationId), role).toEqual([lateMitigation.mitigationId]);
      expect(data.lead?.withoutMitigation.map((f) => f.id), role).toEqual([bare.id]);
      expect(data.lead?.multiProject, role).toBe(false);
    }
    const assessor = await home('assessor');
    if (assessor.variant !== 'recorder') throw new Error(`expected recorder, got ${assessor.variant}`);
    expect(assessor.lead).toBeNull();
    expect(assessor.assigned.map((m) => m.mitigationId).sort()).toEqual([lateMitigation.mitigationId, onTimeMitigation.mitigationId].sort());
    await addProject(fx, { name: 'Second active' });
    const owner = await home('owner');
    if (owner.variant !== 'recorder') throw new Error(`expected recorder, got ${owner.variant}`);
    expect(owner.lead?.multiProject).toBe(true);
  });

  it('viewer: what the team recorded in the last 14 days, and what is still open in each active project', async () => {
    const p = await addProject(fx, { name: 'Active' });
    const gone = await addProject(fx, { name: 'Archived' });
    const old = await save(fx, p.id, { stage: PP, questionId: 'Q-PP-01' });
    await receivedAt(old.id, daysAgo(20));
    await save(fx, p.id, { stage: PP, questionId: 'Q-PP-02', by: 'owner' });
    await save(fx, gone.id, { stage: PP, questionId: 'Q-PP-03' });
    await testDb.project.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    const data = await home('viewer');
    if (data.variant !== 'viewer') throw new Error(`expected viewer, got ${data.variant}`);
    expect(data.recent).toEqual({ groups: [expect.objectContaining({ projectId: p.id, count: 1, who: expect.objectContaining({ userId: fx.members.owner.userId }) })], more: false });
    expect(data.open.map((o) => [o.projectId, o.projectName])).toEqual([[p.id, 'Active']]);
    const counts = await stageView(ctxFor(fx, 'viewer'), p.id, today);
    expect(data.open[0].stages.map((s) => s.noDecision)).toEqual(STAGES.map((s) => counts[s].noDecision));
    expect(data.open[0].stages[0].stops.find((x) => x.id === 'Q-PP-02')).toEqual({
      id: 'Q-PP-02', kind: 'done', title: expect.any(String), href: `/orgs/${fx.org.slug}/projects/${p.id}/stages/${PP}/questions/Q-PP-02`,
    });
  });

  it('reviewer: reviews not sealed, sealed reviews with changes since, and the open findings they raised, of active projects', async () => {
    const p = await addProject(fx, { name: 'Active' });
    const gone = await addProject(fx, { name: 'Archived' });
    const unsealed = await addStageReview(fx, p.id, { stage: PP });
    const changed = await addStageReview(fx, p.id, { stage: IP });
    const steady = await addStageReview(fx, p.id, { stage: 'post-processing' });
    await save(fx, p.id, { stage: IP, questionId: 'Q-IP-01' });
    await sealFixture(fx, changed.id, { projectId: p.id });
    await sealFixture(fx, steady.id, { projectId: p.id });
    await save(fx, p.id, { stage: IP, questionId: 'Q-IP-02' });
    const mine = await addFinding(fx, p.id, { stage: PP, source: 'team', by: 'reviewer' });
    const withdrawnMine = await addFinding(fx, p.id, { stage: PP, source: 'team', by: 'reviewer' });
    await addFindingEvent(fx, withdrawnMine.id, { kind: 'withdrawn' });
    await addFinding(fx, p.id, { stage: PP, source: 'team', by: 'assessor' });
    await addStageReview(fx, gone.id, { stage: PP });
    await addFinding(fx, gone.id, { stage: PP, source: 'team', by: 'reviewer' });
    await testDb.project.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    const data = await home('reviewer');
    if (data.variant !== 'reviewer') throw new Error(`expected reviewer, got ${data.variant}`);
    expect(data.unsealed.map((r) => r.id)).toEqual([unsealed.id]);
    expect(data.changedSinceSeal.map((r) => r.id)).toEqual([changed.id]);
    expect(data.raisedByMe.map((f) => f.id)).toEqual([mine.id]);
  });

  it('Review Focus 2: Home reads nothing of another organisation for a member of both', async () => {
    const b = await buildOrg({ label: 'b' });
    const u = fx.members.assessor;
    await testDb.membership.create({ data: { orgId: b.org.id, userId: u.userId, role: 'assessor' } });
    const asUInB: OrgFixture = { ...b, members: { ...b.members, assessor: { ...u, orgId: b.org.id, orgSlug: b.org.slug } } };
    const pa = await addProject(fx, { name: 'Alpha project of A' });
    const pb = await addProject(b, { name: 'Beta project of B' });
    await save(fx, pa.id, { stage: PP, questionId: 'Q-PP-01' });
    await save(asUInB, pb.id, { stage: IP, questionId: 'Q-IP-01' });
    await save(b, pb.id, { stage: IP, questionId: 'Q-IP-02', by: 'owner' });
    await save(fx, pa.id, { stage: PP, questionId: 'Q-PP-02', by: 'owner' });
    const data = await home('assessor', fx, u.userId, u.name);
    if (data.variant !== 'recorder') throw new Error(`expected recorder, got ${data.variant}`);
    expect(data.next).toMatchObject({ projectId: pa.id, stage: PP });
    expect(await lastSavedBy(ctxFor(fx, 'assessor'), u.userId)).toMatchObject({ projectId: pa.id });
    expect(data.since?.groups.map((g) => [g.projectId, g.who.userId])).toEqual([[pa.id, fx.members.owner.userId]]);
    const text = JSON.stringify(data);
    for (const s of [pb.id, 'Beta project of B', b.org.id, b.org.name, b.members.owner.userId, b.members.owner.name]) expect(text).not.toContain(s);
  });

  it('T9.7: a read that fails is an error, never an empty Home', async () => {
    const ghost: OrgFixture = { ...fx, org: { ...fx.org, id: 'no-such-organisation' } };
    await expect(home('owner', ghost, fx.members.owner.userId)).rejects.toThrow();
  });
});
