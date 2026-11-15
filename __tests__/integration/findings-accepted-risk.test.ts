import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { AcceptRiskRequest, FindingView } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import type { OrgContext } from '@/lib/data/tenant';
import { acceptRisk, acceptedRisksToLookAgain, addMitigation, findingDetail, mitigationHistory } from '@/lib/data/findings';
import { toResponse } from '@/lib/http/toResponse';
import { STORED_CANCEL_REASONS } from '@/lib/findings/storedCancelReasons';
import { resetDb, testDb } from '../helpers/db';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/accepted-risks/route.ts';

let fx: OrgFixture;
let p: { id: string };
let f: { id: string };
let ctx: OrgContext;

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  p = await addProject(fx);
  f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  ctx = ctxFor(fx, 'assessor');
});

const ACCEPT = (): AcceptRiskRequest => ({
  requestId: randomUUID(), mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Out of budget this year',
  lookAgainOn: null, lookAgainNote: null,
});
const actor = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
function accept(over: Partial<AcceptRiskRequest> = {}, role: OrgRole = 'admin', findingId = f.id) {
  const body = { ...ACCEPT(), ...over };
  return acceptRisk(ctxFor(fx, role), actor(role), { ...body, projectId: p.id, findingId }, requestDigest({ path: { id: p.id, findingId }, body }));
}
const postAccept = (role: OrgRole, body: AcceptRiskRequest) => {
  sessionAs(fx.members[role].userId);
  return callRoute(ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id, findingId: f.id }, body });
};
const idsOf = async (list: Promise<FindingView[]>) => (await list).map((x) => x.id);
const answer = async (pr: Promise<unknown>) => {
  try { await pr; } catch (e) { const r = toResponse(e); return { status: r.status, ...(await r.json()) }; }
  throw new Error('expected a refusal');
};

describe('acceptRisk and route 8 (FR-FND-05, SRS 5.3 item 11 rule 2)', () => {
  it('FR-FND-05 UX-17 M-26: an assessor gets 403', async () => {
    const res = await postAccept('assessor', ACCEPT());
    expect(res.status).toBe(403);
    expect(await testDb.acceptedRisk.count()).toBe(0);
    expect(await answer(accept({}, 'assessor'))).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('FR-FND-05: route 8 answers 201 for the admin and 200 for the same request again', async () => {
    const body = ACCEPT();
    const first = await postAccept('admin', body);
    const again = await postAccept('admin', body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect((await again.json()).id).toBe((await first.json()).id);
  });

  it('FR-FND-05: an admin records it; the finding reads closed by accepted risk with who and why', async () => {
    const r = (await accept({ acceptedBy: { kind: 'outside_role', role: 'ethics_committee' } })).value;
    expect(r).toMatchObject({ acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Out of budget this year', accepterRole: null,
      enteredBy: { userId: fx.members.admin.userId }, enteredByRole: 'admin', findingSeq: 1 });
    const d = await findingDetail(ctx, p.id, f.id);
    expect(d.state).toBe('closed_accepted_risk');
    expect(d.acceptedRisk).toMatchObject({ id: r.id });
  });

  it('FR-FND-05 FR-ORG-09: a member who accepted is stored with their role at the time; a non-member answers 422', async () => {
    const r = (await accept({ acceptedBy: { kind: 'member', userId: fx.members.owner.userId } })).value;
    expect(r).toMatchObject({ acceptedBy: { kind: 'member', user: { userId: fx.members.owner.userId } }, accepterRole: 'owner' });
    const g = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const stranger = (await buildOrg()).members.owner.userId;
    await expect(accept({ acceptedBy: { kind: 'member', userId: stranger } }, 'admin', g.id)).rejects.toMatchObject({
      status: 422, extra: { fields: [{ field: 'acceptedBy', message: 'Choose who accepted the risk.' }] } });
  });

  it('FR-FND-05: a planned mitigation gets a cancelled version with reason "risk accepted"', async () => {
    const m = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-10' });
    const done = await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
    const R = randomUUID();
    await accept({ requestId: R });
    const h = await mitigationHistory(ctx, p.id, m.mitigationId);
    expect(h[0]).toMatchObject({ versionNumber: 2, baseVersionNumber: 1, status: 'cancelled', cancelReason: STORED_CANCEL_REASONS.riskAccepted, enteredBy: { userId: fx.members.admin.userId } });
    expect(await testDb.mitigationVersion.findUniqueOrThrow({ where: { id: h[0].id } })).toMatchObject({ requestId: (await import('@/lib/data/idempotency')).derivedRequestId(R, 'mitigation_versions:' + m.mitigationId) });
    expect(await mitigationHistory(ctx, p.id, done.mitigationId)).toHaveLength(1);   // a done one is left as it is
  });

  it('FR-FND-05: two concurrent acceptances: one closes, the other 409 with who and when', async () => {
    for (let i = 0; i < 10; i++) {
      const g = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
      const r = await Promise.allSettled([accept({}, 'admin', g.id), accept({}, 'admin', g.id)]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const lost = (r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason;
      expect(lost).toMatchObject({ status: 409, code: 'finding_not_open', extra: { current: { state: 'closed_accepted_risk', by: { userId: fx.members.admin.userId }, at: expect.any(String) } } });
      expect(await testDb.acceptedRisk.count({ where: { findingId: g.id } })).toBe(1);
    }
  });

  it('FR-FND-05: accepting a risk on a finding closed by a mitigation answers 409; keep accepted needs a finding closed by one', async () => {
    await expect(accept({ mode: 'keep_accepted', lookAgainNote: 'x' })).rejects.toMatchObject({ status: 409, code: 'finding_already_open' });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
    await expect(accept()).rejects.toMatchObject({ status: 409, code: 'finding_not_open', extra: { current: { state: 'closed_mitigation' } } });
    await expect(accept({ mode: 'keep_accepted', lookAgainNote: 'x' })).rejects.toMatchObject({ status: 409, code: 'finding_not_open' });
  });

  it('FR-FND-05: "Looked at again: keep accepted" with a new date leaves the look-again list until that date', async () => {
    await accept({ lookAgainOn: '2026-11-01' });
    expect(await idsOf(acceptedRisksToLookAgain(ctx, p.id, '2026-11-02'))).toEqual([f.id]);
    expect(await idsOf(acceptedRisksToLookAgain(ctx, p.id, '2026-10-31'))).toEqual([]);
    const kept = await acceptRisk(ctxFor(fx, 'owner'), actor('owner'), { ...ACCEPT(), mode: 'keep_accepted', lookAgainOn: '2027-03-01', lookAgainNote: 'Still out of budget', projectId: p.id, findingId: f.id }, 'd'.repeat(64));
    expect(kept.value).toMatchObject({ lookAgainOn: '2027-03-01', lookAgainNote: 'Still out of budget', findingSeq: 2 });
    expect(await idsOf(acceptedRisksToLookAgain(ctx, p.id, '2026-11-02'))).toEqual([]);
    expect(await idsOf(acceptedRisksToLookAgain(ctx, p.id, '2027-03-01'))).toEqual([f.id]);
    const d = await findingDetail(ctx, p.id, f.id);
    expect(d.acceptedRisk?.id).toBe(kept.value.id);
    expect(d.acceptedRisks.map((x) => x.findingSeq)).toEqual([2, 1]);
  });

  it('FR-FND-05 FR-FND-07: after a reopen the earlier acceptance is not on the look-again list', async () => {
    await accept({ lookAgainOn: '2026-11-01' });
    await addFindingEvent(fx, f.id, { kind: 'reopened' });
    expect(await idsOf(acceptedRisksToLookAgain(ctx, p.id, '2026-11-02'))).toEqual([]);
  });

  it('FR-FND-05 FR-FND-03: a mitigation cannot be added once the risk is accepted', async () => {
    await accept();
    const body = { requestId: randomUUID(), what: 'x', ownerUserId: fx.members.assessor.userId, dueDate: '2026-11-10', status: 'planned' as const,
      followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [] };
    await expect(addMitigation(ctx, actor('assessor'), { ...body, projectId: p.id, findingId: f.id }, 'e'.repeat(64)))
      .rejects.toMatchObject({ status: 409, code: 'finding_not_open', extra: { current: { state: 'closed_accepted_risk' } } });
  });

  it('NFR-OBS-01 NFR-PRIV-03: accepting a risk logs RISK_ACCEPTED and FINDING_CLOSED once each with ids and no text', async () => {
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-10' });
    const { lines, result } = await captureLogs(() => accept({ reason: markerFor('reason', 1), lookAgainOn: '2027-01-01', lookAgainNote: markerFor('lookAgainNote', 2) }));
    expect(lines.filter((l) => l.includes('RISK_ACCEPTED'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('FINDING_CLOSED'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('RISK_ACCEPTED'))).toContain(result.value.id);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    const { lines: kept } = await captureLogs(() => accept({ mode: 'keep_accepted', lookAgainNote: markerFor('lookAgainNote', 3) }));
    expect([kept.filter((l) => l.includes('RISK_ACCEPTED')).length, kept.filter((l) => l.includes('FINDING_CLOSED')).length]).toEqual([1, 0]);
  });
});
