import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentRef } from '@/types/api';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { loadStagePage } from '@/lib/question/stagePage';

/**
 * Plan 1C Task 2: the stage page's data, moved to lib/question/stagePage.ts, carries one status mark per question
 * (spec 7.2's table, through the kit's markKindOf) and the personal data question's answer, from the reads it already made.
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

const load = () => loadStagePage(ctxFor(fx, 'assessor'), fx.members.assessor.userId, project.id, 'pre-processing');
const decide = (questionId: string, over: Omit<Parameters<typeof addDecision>[2], 'stage' | 'questionId' | 'contentVersionId'>) =>
  addDecision(fx, project.id, { stage: 'pre-processing', questionId, contentVersionId: c1.contentVersionId, ...over });

/** The marks each row kind allows: the filters' kinds and the marks must tell the same story. */
const ALLOWED: Record<StageRow['kind'], StatusMarkKind[]> = {
  none: ['no_decision'], shortfall: ['partly', 'not_yet'], done: ['done'], not_applicable: ['not_applicable'],
  scope: ['scope_answered'], not_applicable_by_gate: ['does_not_apply'],
};

describe('loadStagePage: marks and the personal data answer', () => {
  it('a new project: one mark per row, keyed by exactly the rows\' ids, each no decision; no answer', async () => {
    const data = (await load())!;
    expect(Object.keys(data.marks).sort()).toEqual(data.rows.map((r) => r.questionId).sort());
    expect(new Set(Object.values(data.marks))).toEqual(new Set(['no_decision']));
    expect(data.scopeAnswer).toBeNull();
  });

  it('each status, the answered personal data question, a gated question after "no" and a withdrawn version give the kit\'s marks', async () => {
    await decide('Q-PP-01', { status: 'done' });
    await decide('Q-PP-02', { status: 'partly' });
    await decide('Q-PP-03', { status: 'not_yet' });
    await decide('Q-PP-04', { status: 'not_applicable' });
    await decide('Q-PP-05', { status: 'done' });
    await decide('Q-PP-05', { status: 'withdrawn', withdrawalCode: 'duplicate' });
    await decide('Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'no' });
    await decide('Q-PP-13', { status: 'done' });   // the gate decides over the question's own decision
    const data = (await load())!;
    expect({
      d: data.marks['Q-PP-01'], p: data.marks['Q-PP-02'], n: data.marks['Q-PP-03'], na: data.marks['Q-PP-04'], w: data.marks['Q-PP-05'],
      g: data.marks['Q-PP-GATE-SENSITIVE'], gated: data.marks['Q-PP-13'], none: data.marks['Q-PP-06'],
    }).toEqual({ d: 'done', p: 'partly', n: 'not_yet', na: 'not_applicable', w: 'no_decision', g: 'scope_answered', gated: 'does_not_apply', none: 'no_decision' });
    expect(data.scopeAnswer).toBe('no');
    for (const r of data.rows) expect(ALLOWED[r.kind], `${r.questionId} (${r.kind})`).toContain(data.marks[r.questionId]);
  });

  it('the personal data answer reaches the later stages too', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'not_sure' });
    const data = await loadStagePage(ctxFor(fx, 'assessor'), fx.members.assessor.userId, project.id, 'in-processing');
    expect(data!.scopeAnswer).toBe('not_sure');
  });

  it('NFR-SEC-02: organisation B\'s project is still null for organisation A', async () => {
    const pB = await addProject(await buildOrg({ label: 'b' }));
    expect(await loadStagePage(ctxFor(fx, 'owner'), fx.members.owner.userId, pB.id, 'pre-processing')).toBeNull();
  });
});
