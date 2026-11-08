import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { SaveDecisionRequest } from '@/types/api';
import { can, type Action } from '@/lib/authz/policy';
import { ALL_ORG_ROLES } from '@/lib/authz/roles';
import { requestDigest } from '@/lib/data/idempotency';
import { saveDecision } from '@/lib/data/decisions';
import { openShortfallForQuestion } from '@/lib/data/findings';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs } from '../helpers/logCapture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addDecision, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

const F = 'app/api/v1/orgs/[slug]/projects/[id]/findings/[findingId]/';
type Table = 'mitigation_versions' | 'accepted_risks' | 'finding_events';
type Arranged = { params: Record<string, string>; body: () => Record<string, unknown>; changed: () => Record<string, unknown> };

let fx: OrgFixture;
let contentVersionId: string;

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
});

const stage = 'pre-processing' as const;
const team = (projectId: string) => addFinding(fx, projectId, { stage, source: 'team', by: 'assessor' });
const MITIGATION = () => ({ what: 'Relabel the minority class', ownerUserId: fx.members.assessor.userId, dueDate: '2026-12-01', status: 'planned',
  followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [] });

/** Each finding route of contract rows 6 to 11 with its gate, primary table, and the objects its request needs (`arrange`). */
const WRITES: ReadonlyArray<{ file: string; gate: Action; table: Table; arrange: (projectId: string, questionId?: string) => Promise<Arranged> }> = [
  { file: 'mitigations/route.ts', gate: 'mitigation:write', table: 'mitigation_versions', arrange: async (projectId) => {
    const f = await team(projectId); const requestId = randomUUID();
    const body = () => ({ requestId, ...MITIGATION() });
    return { params: { id: projectId, findingId: f.id }, body, changed: () => ({ ...body(), what: 'changed' }) };
  } },
  { file: 'mitigations/[mitigationId]/route.ts', gate: 'mitigation:write', table: 'mitigation_versions', arrange: async (projectId) => {
    const f = await team(projectId);
    const m = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({ requestId, ...MITIGATION(), status: 'in_progress', baseVersionNumber: 1, changeNote: null });
    return { params: { id: projectId, findingId: f.id, mitigationId: m.mitigationId }, body, changed: () => ({ ...body(), what: 'changed' }) };
  } },
  { file: 'accepted-risks/route.ts', gate: 'risk:accept', table: 'accepted_risks', arrange: async (projectId) => {
    const f = await team(projectId);
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({ requestId, mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Out of budget',
      lookAgainOn: null, lookAgainNote: null });
    return { params: { id: projectId, findingId: f.id }, body, changed: () => ({ ...body(), reason: 'changed' }) };
  } },
  { file: 'reopen/route.ts', gate: 'finding:reopen', table: 'finding_events', arrange: async (projectId) => {
    const f = await team(projectId);
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const requestId = randomUUID();
    const body = () => ({ requestId, reason: 'Closed too early', eventCode: null });
    return { params: { id: projectId, findingId: f.id }, body, changed: () => ({ ...body(), reason: 'changed' }) };
  } },
  { file: 'withdrawal/route.ts', gate: 'finding:withdraw', table: 'finding_events', arrange: async (projectId) => {
    const f = await team(projectId); const requestId = randomUUID();
    const body = () => ({ requestId, reason: 'Raised in error', eventCode: null });
    return { params: { id: projectId, findingId: f.id }, body, changed: () => ({ ...body(), reason: 'changed' }) };
  } },
  { file: 'close-by-decision/route.ts', gate: 'mitigation:write', table: 'mitigation_versions', arrange: async (projectId, questionId = 'Q-PP-01') => {
    const raising = await addDecision(fx, projectId, { stage, questionId, contentVersionId, status: 'not_yet' });
    const f = await addFinding(fx, projectId, { stage, source: 'shortfall', questionId, decisionVersionId: raising.id });
    const done = await addDecision(fx, projectId, { stage, questionId, contentVersionId, status: 'done' });
    const requestId = randomUUID();
    const body = () => ({ requestId, decisionVersionId: done.id });
    return { params: { id: projectId, findingId: f.id }, body, changed: () => ({ ...body(), decisionVersionId: raising.id }) };
  } },
];

const count = (table: Table) => testDb.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}"`).then(([r]) => r.n);
const call = (file: string, role: OrgRole, params: Record<string, string>, body: unknown) => {
  sessionAs(fx.members[role].userId);
  return callRoute(F + file, 'POST', { slug: fx.org.slug, params, body });
};
/** The further rows one request writes beside its primary row: the acceptance cancels the arranged planned mitigation. */
const extraRows = (file: string) => (file === 'accepted-risks/route.ts' ? 1 : 0);

describe('finding routes 6 to 11 end to end (FR-DEC-07, NFR-INT-02, FR-PRJ-03, FR-AUTHZ-01)', () => {
  for (const w of WRITES) {
    it(`FR-DEC-07 NFR-INT-02: replaying ${w.file} with the same request id creates nothing`, async () => {
      const a = await w.arrange((await addProject(fx)).id);
      const before = await count(w.table);
      const versionsBefore = await count('mitigation_versions');
      const first = await call(w.file, 'owner', a.params, a.body()); const again = await call(w.file, 'owner', a.params, a.body());
      expect([first.status, again.status]).toEqual([201, 200]);
      expect((await again.json()).id).toBe((await first.json()).id);
      expect(await count(w.table)).toBe(before + 1);
      if (w.table !== 'mitigation_versions') expect(await count('mitigation_versions')).toBe(versionsBefore + extraRows(w.file));
      expect((await call(w.file, 'owner', a.params, a.changed())).status).toBe(409);
      const other = await call(w.file, 'admin', a.params, a.body());          // another account, same id: no data
      expect({ status: other.status, body: await other.json() }).toEqual({ status: 409, body: { error: expect.any(String), code: 'request_id_reused' } });
      expect(await count(w.table)).toBe(before + 1);
    });

    it(`FR-PRJ-03 RF-4: ${w.file} in an archived project answers 409 project_archived and writes nothing`, async () => {
      const a = await w.arrange((await addProject(fx, { archived: true })).id);
      const before = [await count(w.table), await count('mitigation_versions')];
      const res = await call(w.file, 'owner', a.params, a.body());
      expect({ status: res.status, code: (await res.json()).code }).toEqual({ status: 409, code: 'project_archived' });
      expect([await count(w.table), await count('mitigation_versions')]).toEqual(before);
    });
  }

  it('FR-DEC-07 NFR-INT-02: the same request id and body sent to another finding answers 409 request_id_reused', async () => {
    for (const w of WRITES) {
      const projectId = (await addProject(fx)).id;
      const a = await w.arrange(projectId); const b = a.body();
      expect((await call(w.file, 'owner', a.params, b)).status).toBe(201);
      const second = await w.arrange(projectId, 'Q-PP-02');
      const res = await call(w.file, 'owner', { ...a.params, findingId: second.params.findingId }, b);
      expect({ file: w.file, status: res.status, code: (await res.json()).code }).toEqual({ file: w.file, status: 409, code: 'request_id_reused' });
    }
  });

  it('NFR-SEC-02 FR-AUTHZ-01: each finding route refuses the roles the matrix leaves out with 403 and writes nothing', async () => {
    let refused = 0;
    for (const w of WRITES) {
      const a = await w.arrange((await addProject(fx)).id);
      for (const role of ALL_ORG_ROLES.filter((r) => !can(r, w.gate))) {
        const before = [await count(w.table), await count('mitigation_versions')];
        const res = await call(w.file, role, a.params, a.body());
        expect({ file: w.file, role, status: res.status, code: (await res.json()).code }).toEqual({ file: w.file, role, status: 403, code: 'forbidden' });
        expect([await count(w.table), await count('mitigation_versions')]).toEqual(before);
        refused++;
      }
    }
    expect(refused).toBe(12);   // viewer and reviewer x 3 mitigation:write routes, + 3 for risk:accept, + 2 for reopen, + 1 for withdraw
  });

  it('FR-FND-01 UX-09 NFR-OBS-01: a "not yet" saved through DEC-a opens one finding, logs FINDING_RAISED once, and S-12 data names it', async () => {
    const p = await addProject(fx);
    const ctx = ctxFor(fx, 'assessor'); const assessor = { userId: fx.members.assessor.userId, role: 'assessor' as const };
    const decision: SaveDecisionRequest = {
      requestId: randomUUID(), stage, questionId: 'Q-PP-01', baseVersionNumber: null, status: 'not_yet', scopeAnswer: null, optionsInPlace: [],
      reasonCode: 'ny_planned_later', reason: 'Planned for the next data release', decidedBy: { kind: 'member', userId: assessor.userId },
      declaredDate: '2026-10-12', evidenceIds: [],
    };
    const { lines } = await captureLogs(() => saveDecision(ctx, assessor, { ...decision, projectId: p.id }, requestDigest({ path: { id: p.id }, body: decision })));
    const open = await openShortfallForQuestion(ctx, p.id, 'Q-PP-01');
    expect(open).not.toBeNull();
    const raised = lines.filter((l) => l.includes('FINDING_RAISED'));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain(open!.findingId);
    expect(await testDb.finding.count({ where: { projectId: p.id, source: 'shortfall' } })).toBe(1);
  });
});
