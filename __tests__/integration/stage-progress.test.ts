import { beforeEach, describe, expect, it } from 'vitest';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { loadProjectOverview, stageView } from '@/lib/data/projects';
import { stageProgress } from '@/lib/project/stageProgress';
import { STAGES } from '@/types/record';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { contentWith, OWNER_TABLE } from '../helpers/contentWith';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/** Task 11: per-stage progress counts (G4) and which stages apply (G7, dormant until content 5.2.0). Content: 0.0.1-fixture. */
let fx: OrgFixture;
let cv: string;
const TODAY = '2026-11-02';

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
});

async function conceptProject(): Promise<{ id: string }> {
  const p = await addProject(fx, { name: 'Concept project' });
  await testDb.projectMetadata.create({ data: { orgId: fx.org.id, projectId: p.id, developmentStage: 'concept' } });
  return p;
}
const overview = (projectId: string, content?: ReturnType<typeof contentWith>) =>
  loadProjectOverview(ctxFor(fx, 'viewer'), { orgSlug: 'x', projectId, today: TODAY, ...(content ? { content } : {}) });

describe('stage progress (G4, G7)', () => {
  it('G4: with the gate answered No, recordable leaves out the gated questions, so a stage with every applying question answered has recorded === recordable', async () => {
    const p = await addProject(fx);
    const stage = 'pre-processing' as const;
    await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
    const content = runningContent();
    const before = stageProgress((await stageView(ctxFor(fx, 'viewer'), p.id, TODAY))[stage]);
    const all = questionsInStage(content, stage);
    expect(before.recordable).toBe(all.length - 2);   // Q-PP-13 and Q-PP-14 are gated
    for (const q of all) {
      if (q.id === 'Q-PP-GATE-SENSITIVE' || q.id === 'Q-PP-13' || q.id === 'Q-PP-14') continue;
      await addDecision(fx, p.id, { stage, questionId: q.id, contentVersionId: cv, status: 'done' });
    }
    const after = stageProgress((await stageView(ctxFor(fx, 'viewer'), p.id, TODAY))[stage]);
    expect(after).toEqual({ recordable: all.length - 2, recorded: all.length - 2 });
  });

  it('G7 dormant: on content with no table, a concept project has applies true for all three stages', async () => {
    const p = await conceptProject();
    const data = await overview(p.id);
    expect(data).not.toBeNull();
    expect(STAGES.map((s) => data!.applies?.[s] ?? true)).toEqual([true, true, true]);
    expect(data!.applies).toEqual({ 'pre-processing': true, 'in-processing': true, 'post-processing': true });
  });

  it('G7 active: with contentWith the owner table, a concept project has applies only for pre-processing, and its in-processing answers still count', async () => {
    const p = await conceptProject();
    await addDecision(fx, p.id, { stage: 'in-processing', questionId: 'Q-IP-01', contentVersionId: cv, status: 'done' });
    const data = await overview(p.id, contentWith({ stageApplicability: OWNER_TABLE }));
    expect(data!.applies).toEqual({ 'pre-processing': true, 'in-processing': false, 'post-processing': false });
    expect(data!.counts['in-processing'].byStatus.done).toBe(1);
    const prog = stageProgress(data!.counts['in-processing']);
    expect(prog.recorded).toBe(1);
  });
});
