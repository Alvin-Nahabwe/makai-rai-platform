import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { sealPreview } from '@/lib/data/reviews';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { markerText } from '../helpers/markers';
import {
  addDecision, addEvidence, addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor,
  type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';
import type { Actor } from '@/types/record';

/** FR-REV-02, UX-18 and FR-CNT-08's S-17 count: what a seal of the stage will hold, shown before sealing. */

const FIXTURE = join(process.cwd(), '__tests__', 'fixtures', 'content', '0.0.1-fixture');
const reasonCodes = (JSON.parse(readFileSync(join(FIXTURE, 'reasonCodes.json'), 'utf8')) as { codes: Array<{ code: string; status: string }> }).codes;
const NA = reasonCodes.filter((c) => c.status === 'not_applicable')[0].code;
const NY = reasonCodes.filter((c) => c.status === 'not_yet')[0].code;
const PRE_QUESTIONS = (JSON.parse(readFileSync(join(FIXTURE, 'questionBank.json'), 'utf8')) as {
  stages: Record<string, { modules: Array<{ questions: Array<{ id: string }> }> }>;
}).stages['pre-processing'].modules.flatMap((m) => m.questions).map((q) => q.id);
const GATE = 'Q-PP-GATE-SENSITIVE';

let fx: OrgFixture;
let p: { id: string };
let r: { id: string };
let fv: string;

const actor = (role: OrgRole): Actor => ({ userId: fx.members[role].userId, role });
const preview = (role: OrgRole, reviewId = r.id) => sealPreview(ctxFor(fx, role), actor(role), reviewId);
const dec = (questionId: string, contentVersionId: string, by: OrgRole = 'assessor', extra: Partial<FixtureDecision> = {}): FixtureDecision =>
  ({ stage: 'pre-processing', questionId, contentVersionId, by, declaredDate: '2026-10-20', ...extra });

/** Every pre-processing question decided, the gate answered `yes`, except `skip`; `withoutEvidence` of the done ones have no evidence. */
async function decideAllPreProcessingExcept(skip: string[], o: { withoutEvidence: number }): Promise<void> {
  const e = await addEvidence(fx, p.id, { kind: 'file' });
  let bare = 0;
  for (const q of PRE_QUESTIONS) {
    if (skip.includes(q)) continue;
    if (q === GATE) { await addDecision(fx, p.id, dec(q, fv, 'assessor', { scopeAnswer: 'yes', status: null })); continue; }
    const evidenceIds = bare < o.withoutEvidence ? [] : [e.id];
    if (evidenceIds.length === 0) bare += 1;
    await addDecision(fx, p.id, dec(q, fv, 'assessor', { status: 'done', evidenceIds }));
  }
}

beforeEach(async () => {
  await resetDb();
  fv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('sealPreview', () => {
  it('FR-REV-02 UX-18: five questions with no decision are listed by id and two done without evidence are counted', async () => {
    await decideAllPreProcessingExcept(['Q-PP-03', 'Q-PP-05', 'Q-PP-07', 'Q-PP-09', 'Q-PP-10'], { withoutEvidence: 2 });
    const s = await preview('reviewer');
    expect(s.noDecision).toEqual(['Q-PP-03', 'Q-PP-05', 'Q-PP-07', 'Q-PP-09', 'Q-PP-10']);
    expect(s.doneWithoutEvidence).toBe(2);
    expect(s.sealer).toEqual({ name: fx.members.reviewer.name, role: 'reviewer' });
    expect(s.scopeAnswer).toEqual({ questionId: GATE, versionNumber: 1, answer: 'yes' });
    expect(s.byStatus).toEqual({ done: PRE_QUESTIONS.length - 6, partly: 0, not_yet: 0, not_applicable: 0 });
  });

  it('FR-REV-02 UX-18: the sealer is the actor, whatever role the preview is read with', async () => {
    expect((await preview('owner')).sealer).toEqual({ name: fx.members.owner.name, role: 'owner' });
    expect((await preview('admin')).sealer).toEqual({ name: fx.members.admin.name, role: 'admin' });
  });

  it('FR-REV-02 (gate rule): a gate answered no leaves its derived questions out of no decision, as the seal does', async () => {
    await addDecision(fx, p.id, dec(GATE, fv, 'assessor', { scopeAnswer: 'no', status: null }));
    const s = await preview('owner');
    expect(s.noDecision).not.toContain('Q-PP-13');
    expect(s.noDecision).not.toContain('Q-PP-14');
    expect(s.noDecision).not.toContain(GATE);
    expect(s.noDecision).toHaveLength(PRE_QUESTIONS.length - 3);
    expect(s.scopeAnswer).toEqual({ questionId: GATE, versionNumber: 1, answer: 'no' });
  });

  it('UX-18: the entered-by count is the number of distinct enteredBy among current versions', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01', fv, 'assessor')); await addDecision(fx, p.id, dec('Q-PP-01', fv, 'admin'));   // admin's v2 is current
    await addDecision(fx, p.id, dec('Q-PP-02', fv, 'admin'));
    expect((await preview('owner')).enteredByPeople).toBe(1);
    await addDecision(fx, p.id, dec('Q-PP-04', fv, 'owner'));
    expect((await preview('owner')).enteredByPeople).toBe(2);
  });

  it('UX-18 FR-REV-02: counts by status, Not applicable and Not yet by reason code, findings, mitigations, files and links', async () => {
    const file = await addEvidence(fx, p.id, { kind: 'file' });
    const link = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.org/protocol' });
    await addDecision(fx, p.id, dec('Q-PP-01', fv, 'assessor', { status: 'done', evidenceIds: [file.id] }));
    await addDecision(fx, p.id, dec('Q-PP-02', fv, 'assessor', { status: 'done', evidenceIds: [link.id] }));
    await addDecision(fx, p.id, dec('Q-PP-04', fv, 'assessor', { status: 'partly' }));
    await addDecision(fx, p.id, dec('Q-PP-06', fv, 'assessor', { status: 'not_yet', reasonCode: NY }));
    await addDecision(fx, p.id, dec('Q-PP-08', fv, 'assessor', { status: 'not_applicable', reasonCode: NA }));
    await addDecision(fx, p.id, dec('Q-PP-11', fv, 'assessor', { status: 'not_applicable', reasonCode: NA }));
    await addDecision(fx, p.id, dec('Q-PP-12', fv, 'assessor', { status: 'withdrawn', withdrawalCode: 'entered_in_error' }));   // a withdrawal counts nowhere
    const f1 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-20' });
    await addFinding(fx, p.id, { stage: 'in-processing', source: 'team' });   // another stage: not counted
    const s = await preview('owner');
    expect(s.byStatus).toEqual({ done: 2, partly: 1, not_yet: 1, not_applicable: 2 });
    expect(s.byReasonCode).toEqual({ [NA]: 2, [NY]: 1 });
    expect([s.openFindings, s.openMitigations]).toEqual([2, 1]);
    expect(s.evidence).toEqual({ files: 1, links: 1 });
    expect(s.doneWithoutEvidence).toBe(0);
    expect(s.noDecision).toContain('Q-PP-12');
  });

  it('FR-CNT-08 (S-17 part): a decision answered on 0.0.1 whose expected practice 0.0.2 rewords counts 1, and 0 after re-saving on 0.0.2', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01', fv));
    await addDecision(fx, p.id, dec('Q-PP-02', fv));   // 0.0.2 does not reword Q-PP-02
    expect((await preview('owner')).rewordedSinceDecision).toBe(0);
    const f2 = (await useFixtureContent('0.0.2-fixture')).contentVersionId;
    expect((await preview('owner')).rewordedSinceDecision).toBe(1);
    await addDecision(fx, p.id, dec('Q-PP-01', f2));
    expect((await preview('owner')).rewordedSinceDecision).toBe(0);
  });

  it('NFR-SEC-02 FR-REV-02: a review of another organisation is not found', async () => {
    const fxB = await buildOrg({ label: 'b' });
    const pB = await addProject(fxB);
    const rB = await addStageReview(fxB, pB.id, { stage: 'pre-processing' });
    await expect(preview('owner', rB.id)).rejects.toThrow(/not found/);
  });
});
