import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContentRef } from '@/types/api';
import type { StoredDecisionStatus } from '@/types/record';
import type { OrgContext } from '@/lib/data/tenant';
import { closeByDecision, findingDetail, findingsToCloseByDecision, listFindings, reopenFinding, updateMitigation } from '@/lib/data/findings';
import { eatDate } from '@/lib/followup/overdue';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs } from '../helpers/logCapture';
import { addDecision, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let cv: ContentRef;
let fx: OrgFixture;
let p: { id: string };
let ctx: OrgContext;
let assessor: { userId: string; role: 'assessor' };
const D = 'd'.repeat(64);

beforeEach(async () => {
  await resetDb();
  cv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  p = await addProject(fx);
  ctx = ctxFor(fx, 'assessor');
  assessor = { userId: fx.members.assessor.userId, role: 'assessor' };
});

const dec = (status: StoredDecisionStatus, questionId = 'Q-PP-01') =>
  addDecision(fx, p.id, { stage: 'pre-processing', questionId, contentVersionId: cv.contentVersionId, status,
    withdrawalCode: status === 'withdrawn' ? 'entered_in_error' : null });
const withdrawn = (_v: { id: string }) => dec('withdrawn');
const shortfallFor = (v: { id: string }, questionId = 'Q-PP-01') =>
  addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId, decisionVersionId: v.id });
const close = (findingId: string, decisionVersionId: string) =>
  closeByDecision(ctx, assessor, { requestId: randomUUID(), decisionVersionId, projectId: p.id, findingId }, D);
const mitigationCount = () => testDb.mitigationVersion.count();

describe('findingsToCloseByDecision and closeByDecision (FR-FND-06, FR-DEC-08)', () => {
  it('FR-FND-06: a finding from version 1 (not yet) with version 2 (done) is listed and the action closes it by a mitigation referencing version 2', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1); const v2 = await dec('done');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, reason: 'decision_done', decisionVersionId: v2.id })]);
    const { lines, result } = await captureLogs(() => close(f.id, v2.id));
    expect(result.value).toMatchObject({ kind: 'decision_changed', status: 'done', closureDecisionVersionId: v2.id, owner: { userId: assessor.userId },
      what: null, versionNumber: 1, dueDate: eatDate(new Date()), enteredByRole: 'assessor' });
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('closed_mitigation');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([]);
    expect(lines.filter((l) => l.includes('FINDING_CLOSED'))).toHaveLength(1);
  });

  it('FR-FND-06: a "not applicable" decision is listed too', async () => {
    const f = await shortfallFor(await dec('partly')); const v2 = await dec('not_applicable');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, reason: 'decision_done', decisionVersionId: v2.id })]);
  });

  it('FR-FND-06: an open finding on Q-PP-13 is listed once the gate is answered "no"', async () => {
    const f = await shortfallFor(await dec('not_yet', 'Q-PP-13'), 'Q-PP-13');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([]);
    await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv.contentVersionId, scopeAnswer: 'yes' });
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([]);
    const gate = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv.contentVersionId, scopeAnswer: 'no' });
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, reason: 'gate_no', decisionVersionId: gate.id })]);
    expect((await close(f.id, gate.id)).value).toMatchObject({ kind: 'decision_changed', closureDecisionVersionId: gate.id });
  });

  it('FR-FND-06 FR-DEC-08: a withdrawn raising version lists the finding under decision withdrawn and closes it with kind decision_withdrawn', async () => {
    const v = await dec('not_yet'); const f = await shortfallFor(v); const w = await withdrawn(v);
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, reason: 'decision_withdrawn', decisionVersionId: w.id })]);
    expect((await close(f.id, w.id)).value.kind).toBe('decision_withdrawn');
  });

  it('FR-FND-06: a decision version that does not qualify answers 422 and writes nothing', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1);
    await expect(close(f.id, v1.id)).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'decisionVersionId', message: 'Choose the decision version that closes this finding.' }] } });
    const v2 = await dec('done'); await dec('partly');                      // done, but no longer current
    await expect(close(f.id, v2.id)).rejects.toMatchObject({ status: 422 });
    const other = await buildOrg(); const op = await addProject(other);
    const foreign = await addDecision(other, op.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: cv.contentVersionId, status: 'done' });
    await expect(close(f.id, foreign.id)).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'decisionVersionId', message: 'Choose the decision version that closes this finding.' }] } });
    expect(await mitigationCount()).toBe(0);
  });

  it('FR-FND-06: team findings and closed findings are not listed; closing a closed one answers 409', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1);
    await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01', decisionVersionId: v1.id });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
    const v2 = await dec('done');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([]);
    await expect(close(f.id, v2.id)).rejects.toMatchObject({ status: 409, code: 'finding_not_open' });
  });

  it('FR-FND-06 FR-FND-07: an update of a decision closure after a reopen keeps its kind (history is not relabelled)', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1); const v2 = await dec('done');
    const m = (await close(f.id, v2.id)).value;
    await reopenFinding(ctx, assessor, { requestId: randomUUID(), reason: 'Not fixed after all', eventCode: null, projectId: p.id, findingId: f.id }, D);
    const next = (await updateMitigation(ctx, assessor, {
      requestId: randomUUID(), what: 'Recheck the labels', ownerUserId: assessor.userId, dueDate: eatDate(new Date()), status: 'in_progress',
      followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [], baseVersionNumber: 1, changeNote: null,
      projectId: p.id, findingId: f.id, mitigationId: m.mitigationId,
    }, D)).value;
    expect(next).toMatchObject({ versionNumber: 2, kind: 'decision_changed', status: 'in_progress' });
  });

  it('FR-FND-06: a decision that already closed its mitigation is not offered again, and a second close writes nothing', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1);
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });   // keeps it open
    const v2 = await dec('done');
    await close(f.id, v2.id);
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('open');
    expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([]);
    const before = await mitigationCount();
    await expect(close(f.id, v2.id)).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'decisionVersionId' }] } });
    expect(await mitigationCount()).toBe(before);
  });

  it('FR-FND-06 UX-15: with the running content not published, the S-14 reads still answer (no 503)', async () => {
    const v1 = await dec('not_yet'); const f = await shortfallFor(v1); const v2 = await dec('done');
    // useFixtureContent republishes the row in the next test's beforeEach; it is restored here as well.
    await testDb.frameworkVersion.update({ where: { id: cv.contentVersionId }, data: { status: 'deprecated' } });
    try {
      expect(await listFindings(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, state: 'open' })]);
      // The suggestions read the running content's files (the gate conditions), never the registry row, so they still come.
      expect(await findingsToCloseByDecision(ctx, p.id)).toEqual([expect.objectContaining({ id: f.id, decisionVersionId: v2.id })]);
    } finally {
      await testDb.frameworkVersion.update({ where: { id: cv.contentVersionId }, data: { status: 'published' } });
    }
  });
});
