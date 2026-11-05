import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { stageView } from '@/lib/data/projects';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addEvidence, addFinding, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor,
  type OrgFixture,
} from '../helpers/recordFixture';

/**
 * PRJ Task 4: stageView, the per-stage counts of S-10 (FR-PRJ-02). Records are set up with the record fixture builder,
 * never a service. Content is the H0 fixture bundle 0.0.1-fixture (G-17).
 */
let fx: OrgFixture;
let p: { id: string };
let cv: string;

beforeAll(async () => {
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
});

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  p = await addProject(fx, { name: 'Counted project' });
  const stage = 'pre-processing' as const;
  // pre-processing: Q-PP-01 done with evidence; Q-PP-02, Q-PP-03 done without; Q-PP-04 partly; Q-PP-05 not_yet;
  // Q-PP-06 not_applicable; Q-PP-07 done then withdrawn; the gate Q-PP-GATE-SENSITIVE answered 'no' (Q-PP-13, Q-PP-14 are gated).
  const ev = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.org/e' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done', evidenceIds: [ev.id] });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-03', contentVersionId: cv, status: 'done' });
  const partly = await addDecision(fx, p.id, { stage, questionId: 'Q-PP-04', contentVersionId: cv, status: 'partly' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-05', contentVersionId: cv, status: 'not_yet' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-06', contentVersionId: cv, status: 'not_applicable' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-07', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-07', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
  // F1: a shortfall on Q-PP-04, open, no mitigation. F2: a team finding whose risk is accepted.
  await addFinding(fx, p.id, { stage, source: 'shortfall', questionId: 'Q-PP-04', decisionVersionId: partly.id });
  const f2 = await addFinding(fx, p.id, { stage, source: 'team' });
  await addAcceptedRisk(fx, f2.id, {});
  // one sealed review with one issued data card
  const review = await addStageReview(fx, p.id, { stage });
  const seal = await addSealRow(fx, review.id, { contentVersionId: cv });
  await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id] });
  await addDecision(fx, p.id, { stage: 'post-processing', questionId: 'Q-PO-01', contentVersionId: cv, status: 'done' });
});

describe('stageView counts (FR-PRJ-02)', () => {
  it('FR-PRJ-02: each stage count equals the fixture\'s (the fields PRJ computes)', async () => {
    const v = await stageView(ctxFor(fx, 'viewer'), p.id, '2026-11-02');
    const nPre = questionsInStage(runningContent(), 'pre-processing').length;
    expect(v['pre-processing']).toMatchObject({
      questions: nPre, noDecision: nPre - 9, notApplicableByGate: 2,
      byStatus: { done: 3, partly: 1, not_yet: 1, not_applicable: 1 }, doneWithoutEvidence: 2,
      openFindingsWithoutMitigation: 1, acceptedRisks: 1, documentsIssued: 1,
    });
    expect(v['in-processing']).toMatchObject({
      noDecision: questionsInStage(runningContent(), 'in-processing').length,
      byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 }, acceptedRisks: 0, documentsIssued: 0,
    });
    expect(v['post-processing'].byStatus.done).toBe(1);
  });

  it('FR-PRJ-02: a decision recorded in post-processing first counts there, and only there', async () => {
    const q = await addProject(fx);
    await addDecision(fx, q.id, { stage: 'post-processing', questionId: 'Q-PO-02', contentVersionId: cv, status: 'done' });
    const v = await stageView(ctxFor(fx, 'assessor'), q.id, '2026-11-02');
    expect([v['pre-processing'].byStatus.done, v['in-processing'].byStatus.done, v['post-processing'].byStatus.done]).toEqual([0, 0, 1]);
  });

  it('FR-PRJ-02: a gate answered yes keeps its gated questions in the count of questions with no decision', async () => {
    const q = await addProject(fx);
    await addDecision(fx, q.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'yes' });
    const v = await stageView(ctxFor(fx, 'viewer'), q.id, '2026-11-02');
    const n = questionsInStage(runningContent(), 'pre-processing').length;
    expect(v['pre-processing']).toMatchObject({ notApplicableByGate: 0, noDecision: n - 1 });
  });
});
