import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext } from '@/lib/data/tenant';
import { addMitigation, listFindings, mitigationHistory, updateMitigation } from '@/lib/data/findings';
import { resetDb } from '../helpers/db';
import { addAcceptedRisk, addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let fx: OrgFixture;
let p: { id: string };
let f: { id: string };
let ctx: OrgContext;

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  p = await addProject(fx);
  f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  ctx = ctxFor(fx, 'viewer');
});

describe('listFindings and mitigationHistory (UX-15, FR-FND-03, FR-FND-07)', () => {
  it('UX-15 FR-FUP-02 (helper): a planned mitigation due yesterday counts as overdue on an open finding', async () => {
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    expect((await listFindings(ctx, p.id, undefined, '2026-11-02'))[0]).toMatchObject({ overdueMitigations: 1, openMitigations: 1, hasNoMitigation: false });
    expect((await listFindings(ctx, p.id, undefined, '2026-11-01'))[0]).toMatchObject({ overdueMitigations: 0 });
  });

  it('UX-15: a finding with no planned or in-progress mitigation has none; overdue counts only on an open finding', async () => {
    expect((await listFindings(ctx, p.id))[0]).toMatchObject({ state: 'open', openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0 });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-01' });
    await addAcceptedRisk(fx, f.id, {});
    expect((await listFindings(ctx, p.id, undefined, '2026-12-01'))[0]).toMatchObject({ state: 'closed_accepted_risk', overdueMitigations: 0 });
  });

  it('FR-FND-03: mitigation history lists every version newest first with change notes', async () => {
    const as = ctxFor(fx, 'assessor'); const who = { userId: fx.members.assessor.userId, role: 'assessor' as const };
    const body = (over: object) => ({ requestId: randomUUID(), what: 'Relabel', ownerUserId: who.userId, dueDate: '2026-11-01',
      status: 'planned' as const, followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [], ...over });
    const m = (await addMitigation(as, who, { ...body({}), projectId: p.id, findingId: f.id }, 'a'.repeat(64))).value;
    const at = { projectId: p.id, findingId: f.id, mitigationId: m.mitigationId };
    await updateMitigation(as, who, { ...body({ status: 'in_progress' }), baseVersionNumber: 1, changeNote: null, ...at }, 'b'.repeat(64));
    await updateMitigation(as, who, { ...body({ status: 'in_progress', dueDate: '2026-12-01' }), baseVersionNumber: 2, changeNote: 'Labeller unavailable', ...at }, 'c'.repeat(64));
    const h = await mitigationHistory(ctx, p.id, m.mitigationId);
    expect(h.map((v) => v.versionNumber)).toEqual([3, 2, 1]); expect(h[0].changeNote).toBe('Labeller unavailable');
    expect(await mitigationHistory(ctx, (await addProject(fx)).id, m.mitigationId)).toEqual([]);   // not of that project
  });

  it('FR-FND-07: listFindings states withdrawn findings as withdrawn', async () => {
    const withdrawnTeam = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addFindingEvent(fx, withdrawnTeam.id, { kind: 'withdrawn' });
    expect((await listFindings(ctx, p.id)).find((x) => x.id === withdrawnTeam.id)!.state).toBe('withdrawn');
  });

  it('UX-15 NFR-SEC-02: listFindings filters by stage, orders oldest first, and reads only the project and organisation asked', async () => {
    const later = await addFinding(fx, p.id, { stage: 'in-processing', source: 'team' });
    await addFinding(fx, (await addProject(fx)).id, { stage: 'pre-processing', source: 'team' });
    expect((await listFindings(ctx, p.id)).map((x) => x.id)).toEqual([f.id, later.id]);
    expect((await listFindings(ctx, p.id, 'in-processing')).map((x) => x.id)).toEqual([later.id]);
    expect(await listFindings(ctxFor(await buildOrg(), 'owner'), p.id)).toEqual([]);
  });
});
