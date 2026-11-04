import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { AddMitigationRequest, FindingEventRequest, MitigationVersionView, UpdateMitigationRequest } from '@/types/api';
import type { WriteOutcome } from '@/types/record';
import { requestDigest } from '@/lib/data/idempotency';
import type { OrgContext } from '@/lib/data/tenant';
import { acceptRisk, addMitigation, findingDetail, reopenFinding, updateMitigation, withdrawFinding } from '@/lib/data/findings';
import { toResponse } from '@/lib/http/toResponse';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addEvidence, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let fx: OrgFixture;
let p: { id: string };
let f: { id: string };
let ctx: OrgContext;
let ev: { id: string };

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  p = await addProject(fx);
  f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  ctx = ctxFor(fx, 'assessor');
  ev = await addEvidence(fx, p.id, { kind: 'file' });
});

const actor = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
const EVENT = (): FindingEventRequest => ({ requestId: randomUUID(), reason: 'Raised in error', eventCode: null });
function event(fn: typeof reopenFinding, role: OrgRole, findingId: string, over: Partial<FindingEventRequest>) {
  const body = { ...EVENT(), ...over };
  return fn(ctxFor(fx, role), actor(role), { ...body, projectId: p.id, findingId }, requestDigest({ path: { id: p.id, findingId }, body }));
}
const reopen = (role: OrgRole, findingId = f.id, over: Partial<FindingEventRequest> = {}) => event(reopenFinding, role, findingId, over);
const withdraw = (role: OrgRole, findingId: string, over: Partial<FindingEventRequest> = {}) => event(withdrawFinding, role, findingId, over);
const closeByMitigation = (finding: { id: string }) => addMitigationVersion(fx, finding.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
const accept = () => acceptRisk(ctxFor(fx, 'admin'), actor('admin'), {
  requestId: randomUUID(), mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Accepted',
  lookAgainOn: null, lookAgainNote: null, projectId: p.id, findingId: f.id,
}, 'a'.repeat(64));
function add(over: Partial<AddMitigationRequest>): Promise<WriteOutcome<MitigationVersionView>> {
  const body: AddMitigationRequest = { requestId: randomUUID(), what: 'Retrain', ownerUserId: fx.members.assessor.userId, dueDate: '2026-11-20',
    status: 'planned', followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [], ...over };
  return addMitigation(ctx, actor('assessor'), { ...body, projectId: p.id, findingId: f.id }, requestDigest({ path: { id: p.id, findingId: f.id }, body }));
}
function update(m: WriteOutcome<MitigationVersionView>, over: Partial<UpdateMitigationRequest>) {
  const body: UpdateMitigationRequest = { requestId: randomUUID(), what: 'Retrain', ownerUserId: fx.members.assessor.userId, dueDate: '2026-11-20',
    status: 'planned', followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [], baseVersionNumber: 1, changeNote: null, ...over };
  return updateMitigation(ctx, actor('assessor'), { ...body, projectId: p.id, findingId: f.id, mitigationId: m.value.mitigationId }, 'b'.repeat(64));
}
const eventsCount = () => testDb.findingEvent.count();
const answer = async (pr: Promise<unknown>) => {
  try { await pr; } catch (e) { const r = toResponse(e); return { status: r.status, ...(await r.json()) }; }
  throw new Error('expected a refusal');
};

describe('reopenFinding and withdrawFinding (FR-FND-07, SRS 5.3 item 11)', () => {
  it('FR-FND-07: a closed finding reopened is open, and its history shows the closure and the reopening', async () => {
    await closeByMitigation(f);
    const r = await reopen('assessor');
    expect(r.value).toMatchObject({ kind: 'reopened', reason: 'Raised in error', eventCode: null, by: { userId: fx.members.assessor.userId }, findingSeq: 2 });
    const d = await findingDetail(ctx, p.id, f.id);
    expect(d.state).toBe('open');
    expect(d.events.map((e) => e.kind)).toEqual(['reopened']);
    expect(d.mitigations[0].current.status).toBe('done');
  });

  it('FR-FND-07: after a reopen it accepts a new mitigation, and closes again only on a done version saved after the reopen', async () => {
    await closeByMitigation(f); await reopen('assessor');
    const n = await add({ status: 'planned' });
    expect(n.replayed).toBe(false);                                   // the 201 of FR-FND-07's test
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('open');
    await update(n, { baseVersionNumber: 1, status: 'done', evidenceIds: [ev.id] });
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('closed_mitigation');
  });

  it('FR-FND-07: a reopen makes the earlier accepted risk inactive; it stays in the history', async () => {
    await accept(); await reopen('owner');
    const d = await findingDetail(ctx, p.id, f.id);
    expect(d.state).toBe('open');
    expect(d.acceptedRisk).toBeNull(); expect(d.acceptedRisks).toHaveLength(1);   // G058
  });

  it('FR-FND-07: only the raiser, an owner or an admin withdraws a team finding', async () => {
    const t = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'reviewer' });
    expect(await answer(withdraw('assessor', t.id))).toMatchObject({ status: 403, code: 'forbidden' });
    await expect(withdraw('reviewer', t.id)).resolves.toMatchObject({ value: { kind: 'withdrawn' } });
    for (const role of ['owner', 'admin'] as const) {
      const u = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'assessor' });
      await expect(withdraw(role, u.id)).resolves.toMatchObject({ value: { kind: 'withdrawn', by: { userId: fx.members[role].userId } } });
    }
    const v = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'assessor' });
    expect(await answer(withdraw('reviewer', v.id))).toMatchObject({ status: 403 });
    expect(await answer(withdraw('viewer', v.id))).toMatchObject({ status: 403 });
  });

  it('FR-FND-07: withdrawing a shortfall finding answers 409; a withdrawn finding cannot be reopened', async () => {
    const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
    const raising = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });
    const shortfall = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
    await expect(withdraw('owner', shortfall.id)).rejects.toMatchObject({ status: 409, code: 'cannot_withdraw_shortfall' });
    const t = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' }); await withdraw('owner', t.id);
    await expect(reopen('owner', t.id)).rejects.toMatchObject({ status: 409, code: 'finding_withdrawn' });
    await expect(withdraw('owner', t.id)).rejects.toMatchObject({ status: 409, code: 'finding_withdrawn' });
  });

  it('FR-FND-07: a closed team finding withdrawn never counts as closed', async () => {
    await closeByMitigation(f); await withdraw('owner', f.id);
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('withdrawn');
  });

  it('FR-FND-07 UX-29 (server half): a withdrawal or a reopen without a reason answers 422 and writes nothing', async () => {
    const team = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await expect(withdraw('owner', team.id, { reason: '' })).rejects.toMatchObject({ status: 422 });
    await closeByMitigation(f);
    await expect(reopen('owner', f.id, { reason: '   ' })).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'reason', message: 'Write a reason.' }] } });
    expect(await eventsCount()).toBe(0);
  });

  it('FR-FND-07: reopening an open finding answers 409 finding_already_open', async () => {
    await expect(reopen('owner')).rejects.toMatchObject({ status: 409, code: 'finding_already_open' });
  });

  it('FR-AUTHZ-01 NFR-SEC-02: a reviewer cannot reopen; a finding of another project answers 404', async () => {
    await closeByMitigation(f);
    expect(await answer(reopen('reviewer'))).toMatchObject({ status: 403, code: 'forbidden' });
    const other = await addProject(fx);
    const body = EVENT();
    expect(await answer(reopenFinding(ctxFor(fx, 'owner'), actor('owner'), { ...body, projectId: other.id, findingId: f.id }, 'c'.repeat(64))))
      .toMatchObject({ status: 404 });
    expect(await eventsCount()).toBe(0);
  });

  it('FR-DEC-07 NFR-INT-02: a request id used to withdraw cannot reopen, and one used to reopen cannot withdraw (409 request_id_reused)', async () => {
    const t = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const X = { requestId: randomUUID(), reason: 'Same words', eventCode: null };
    await withdraw('owner', t.id, X);
    await expect(reopen('owner', t.id, X)).rejects.toMatchObject({ status: 409, code: 'request_id_reused' });
    await closeByMitigation(f);
    const Y = { requestId: randomUUID(), reason: 'Same words', eventCode: null };
    await reopen('owner', f.id, Y);
    await expect(withdraw('owner', f.id, Y)).rejects.toMatchObject({ status: 409, code: 'request_id_reused' });
    expect((await testDb.findingEvent.findMany({ orderBy: { findingSeq: 'asc' } })).map((e) => [e.findingId, e.kind]))
      .toEqual(expect.arrayContaining([[t.id, 'withdrawn'], [f.id, 'reopened']]));
    expect(await eventsCount()).toBe(2);
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('open');
  });
});
