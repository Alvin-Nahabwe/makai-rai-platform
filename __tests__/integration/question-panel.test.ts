import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { ContentRef } from '@/types/api';
import type { Identity } from '@/lib/auth/identity';
import { NotFoundError } from '@/lib/data/tenant';
import { loadQuestionPanel } from '@/lib/question/panel';
import { isReworded } from '@/lib/question/reworded';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * S-12's panel data (FR-DEC-01, FR-CNT-07, FR-CNT-08, FR-DEC-10, UX-10, UX-11, UX-26), read through the tenant lane
 * on the fixture content bundle (contract "Content bundle"): the question ids are fixture ids.
 */
let c1: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  c1 = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const identity = (role: OrgRole): Identity => ({
  userId: fx.members[role].userId, email: fx.members[role].email, name: fx.members[role].name, platformRole: 'assessor', mustChangePassword: false,
});
const panel = (role: OrgRole, questionId: string) =>
  loadQuestionPanel(ctxFor(fx, role), identity(role), { projectId: project.id, stage: 'pre-processing', questionId });

describe('loadQuestionPanel', () => {
  it('FR-CNT-08 FR-CNT-07: after the running content rewords the practice, the panel holds both wordings', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done' });
    await useFixtureContent('0.0.2-fixture');
    const d = await panel('assessor', 'Q-PP-01');
    expect(d.question.expectedPractice).not.toBe(d.runningQuestion.expectedPractice);
    expect(isReworded(d.question, d.runningQuestion)).toBe(true);
    expect(d.contentSemver).toBe('0.0.2-fixture');
    expect(d.current?.versionNumber).toBe(1);
    expect(d.historyCount).toBe(1);
  });

  it('FR-CNT-07: with no decision, or a withdrawal as the current version, the question is the running wording', async () => {
    await useFixtureContent('0.0.2-fixture');
    const none = await panel('assessor', 'Q-PP-01');
    expect(none.question.expectedPractice).toBe(none.runningQuestion.expectedPractice);
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'withdrawn', withdrawalCode: 'duplicate' });
    const w = await panel('assessor', 'Q-PP-01');
    expect(w.current?.status).toBe('withdrawn');
    expect(w.question.expectedPractice).toBe(w.runningQuestion.expectedPractice);
  });

  it('FR-DEC-10 UX-10: Same as my last save comes from the viewer\'s newest save in this project only', async () => {
    const empty = await panel('assessor', 'Q-PP-02');
    expect(empty.lastOwnSaveDate).toBeNull();
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'done', declaredDate: '2026-10', by: 'assessor' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-03', contentVersionId: c1.contentVersionId, status: 'done', declaredDate: '2026-09-01', by: 'owner' });
    const other = await addProject(fx);
    await addDecision(fx, other.id, { stage: 'pre-processing', questionId: 'Q-PP-04', contentVersionId: c1.contentVersionId, status: 'done', declaredDate: '2025', by: 'assessor' });
    expect((await panel('assessor', 'Q-PP-02')).lastOwnSaveDate).toBe('2026-10');
  });

  it('FR-DEC-01 UX-31: the form is writable for owner, admin and assessor, and for nobody in an archived project', async () => {
    for (const r of ['owner', 'admin', 'assessor'] as const) expect((await panel(r, 'Q-PP-01')).canWrite).toBe(true);
    for (const r of ['reviewer', 'viewer'] as const) expect((await panel(r, 'Q-PP-01')).canWrite).toBe(false);
    expect((await panel('reviewer', 'Q-PP-01')).canRaiseFinding).toBe(true);
    expect((await panel('viewer', 'Q-PP-01')).canRaiseFinding).toBe(false);
    project = await addProject(fx, { archived: true });
    expect(await panel('owner', 'Q-PP-01')).toMatchObject({ canWrite: false, canRaiseFinding: false, projectArchived: true });
  });

  it('NFR-SEC-02: the question panel of organisation B\'s project is not found for organisation A', async () => {
    const pB = await addProject(await buildOrg({ label: 'b' }));
    await expect(loadQuestionPanel(ctxFor(fx, 'owner'), identity('owner'), { projectId: pB.id, stage: 'pre-processing', questionId: 'Q-PP-01' }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it('NFR-SEC-02 FR-DEC-01: a question id the running content lacks, or one of another stage, is not found', async () => {
    await expect(panel('owner', 'Q-PP-999')).rejects.toBeInstanceOf(NotFoundError);
    await expect(panel('owner', 'Q-IP-01')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('UX-11 UX-42 UX-26 NFR-SEC-02: members are of this organisation only, without the viewer; position follows the stage order; orgId is the context organisation', async () => {
    await buildOrg({ label: 'other' });   // its five members must not be listed
    const d = await panel('assessor', 'Q-PP-01');
    expect(d.orgId).toBe(fx.org.id);
    expect(d.orgSlug).toBe(fx.org.slug);
    expect(d.viewer).toEqual({ userId: fx.members.assessor.userId, name: fx.members.assessor.name, role: 'assessor' });
    expect(d.members.map((m) => m.userId)).not.toContain(fx.members.assessor.userId);
    expect(d.members.map((m) => m.userId).sort()).toEqual(['owner', 'admin', 'reviewer', 'viewer'].map((r) => fx.members[r as OrgRole].userId).sort());
    expect(d.position).toMatchObject({ index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' });
  });

  it('FR-CNT-04 (screen) owner question B13: with the gate at no, Q-PP-13 and Q-PP-14 leave the position; unanswered, they count', async () => {
    expect((await panel('assessor', 'Q-PP-GATE-SENSITIVE')).position.nextId).toBe('Q-PP-13');
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: c1.contentVersionId, scopeAnswer: 'no' });
    const d = await panel('assessor', 'Q-PP-GATE-SENSITIVE');
    expect(d.gateAnswer).toBe('no');
    expect(d.position.total).toBe(22);
    expect(d.position.nextId).toBe('Q-PP-15');
  });
});
