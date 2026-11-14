import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentRef } from '@/types/api';
import { NotFoundError } from '@/lib/data/tenant';
import { loadContent } from '@/lib/content/loader';
import { loadQuestionOpenWork } from '@/lib/question/openWork';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';

/**
 * The read-only page's open work (plan 1C Task 7, R2 of the lane 6 brief): the open findings of one question, each with its
 * open mitigations, read through the tenant lane (row-level security applies) on the fixture content bundle.
 */
const TODAY = '2026-11-14';
let c1: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  c1 = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const work = (projectId = project.id, questionId = 'Q-PP-01', o: { fx?: OrgFixture } = {}) =>
  loadQuestionOpenWork(ctxFor(o.fx ?? fx, 'viewer'), { projectId, stage: 'pre-processing', questionId, today: TODAY });

describe('loadQuestionOpenWork', () => {
  it('lists the open findings of this question only, each with its open mitigations, overdue ones first', async () => {
    const mine = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    const bare = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    const otherQuestion = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-02' });
    const otherStage = await addFinding(fx, project.id, { stage: 'in-processing', source: 'team', questionId: 'Q-PP-01' });
    const closed = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    await addAcceptedRisk(fx, closed.id, {});
    const withdrawn = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    await addFindingEvent(fx, withdrawn.id, { kind: 'withdrawn' });
    await addMitigationVersion(fx, otherQuestion.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    await addMitigationVersion(fx, mine.id, { status: 'planned', owner: 'admin', dueDate: '2026-12-01' });
    await addMitigationVersion(fx, mine.id, { status: 'in_progress', owner: 'assessor', dueDate: '2026-11-10' });
    await addMitigationVersion(fx, mine.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-01' });

    const w = await work();
    expect(w.findings.map((f) => f.findingId)).toEqual([mine.id, bare.id]);
    for (const absent of [otherQuestion, otherStage, closed, withdrawn]) expect(w.findings.map((f) => f.findingId)).not.toContain(absent.id);
    const [first, second] = w.findings;
    expect(first.title).toMatch(/^Fixture title \d+$/);   // the team finding's own title
    expect(first.mitigations).toEqual([
      { what: expect.any(String), assignedTo: fx.members.assessor.name, dueDate: '2026-11-10', overdue: true, status: 'in_progress' },
      { what: expect.any(String), assignedTo: fx.members.admin.name, dueDate: '2026-12-01', overdue: false, status: 'planned' },
    ]);
    expect(second.mitigations).toEqual([]);
  });

  it('a shortfall finding is named as the findings list names it: the question text of the version it was raised from', async () => {
    const v = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: c1.contentVersionId, status: 'partly' });
    await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: v.id });
    await useFixtureContent('0.0.2-fixture');
    const [f] = (await work()).findings;
    expect(f.title).toBe(loadContent('0.0.1-fixture' as never).questions.get('Q-PP-01')!.text);
    const team = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    expect(FINDINGS_COPY.finding.untitled).toBe('Untitled finding');
    expect((await work()).findings.find((x) => x.findingId === team.id)!.title).toMatch(/^Fixture title /);
  });

  it('NFR-SEC-02: organisation B\'s project, and a project id that does not exist, are not found for organisation A', async () => {
    const fxB = await buildOrg({ label: 'b' });
    const pB = await addProject(fxB);
    await addFinding(fxB, pB.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    await expect(work(pB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(work('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
    // B's own context reads it: the refusal is the tenancy, not a broken read.
    expect((await work(pB.id, 'Q-PP-01', { fx: fxB })).findings).toHaveLength(1);
  });

  it('review M6: a finding on the same question id in another project of the same organisation is not in the list', async () => {
    const other = await addProject(fx);
    const theirs = await addFinding(fx, other.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    await addMitigationVersion(fx, theirs.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const mine = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    const w = await work();
    expect(w.findings.map((f) => f.findingId)).toEqual([mine.id]);
    expect(w.findings[0].mitigations).toEqual([]);
    // The other project reads its own: the absence above is the project filter, not a broken read.
    expect((await work(other.id)).findings.map((f) => f.findingId)).toEqual([theirs.id]);
  });

  it('S4: the result holds exactly the fields of R2, so a spread of a FindingView or a FollowUpItem fails here', async () => {
    const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const w = await work();
    expect(Object.keys(w)).toEqual(['findings']);
    expect(Object.keys(w.findings[0]).sort()).toEqual(['findingId', 'mitigations', 'title']);
    expect(Object.keys(w.findings[0].mitigations[0]).sort()).toEqual(['assignedTo', 'dueDate', 'overdue', 'status', 'what']);
    const json = JSON.stringify(w);
    for (const leak of [fx.members.assessor.userId, fx.members.assessor.email, 'Fixture description']) expect(json).not.toContain(leak);
  });
});
