import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredDecisionStatus } from '@/types/record';
import type { ContentRef } from '@/types/api';
import { derivedRequestId } from '@/lib/data/idempotency';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { acceptRisk, onShortfallSaved, openShortfallForQuestion, reopenFinding } from '@/lib/data/findings';
import { saveDecision } from '@/lib/data/decisions';
import { requestDigest } from '@/lib/data/idempotency';
import type { SaveDecisionRequest } from '@/types/api';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';

let cv: ContentRef;
let fx: OrgFixture;
let p: { id: string };
let ctx: OrgContext;

beforeEach(async () => {
  await resetDb();
  cv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  p = await addProject(fx);
  ctx = ctxFor(fx, 'assessor');
});

type Version = { id: string; projectId: string; stage: 'pre-processing'; questionId: string; status: StoredDecisionStatus | null; enteredById: string };

/** A decision version of the question, written by the fixture builder (a gate answer when status is null). */
async function version(status: StoredDecisionStatus | null, questionId = 'Q-PP-01'): Promise<Version> {
  const v = await addDecision(fx, p.id, {
    stage: 'pre-processing', questionId, contentVersionId: cv.contentVersionId, status,
    scopeAnswer: status === null ? 'yes' : null, withdrawalCode: status === 'withdrawn' ? 'entered_in_error' : null,
  });
  return { id: v.id, projectId: p.id, stage: 'pre-processing', questionId, status, enteredById: fx.members.assessor.userId };
}
const call = (v: Version, req = { requestId: randomUUID(), digest: 'a'.repeat(64) }) =>
  withOrg(ctx, (tx) => onShortfallSaved(tx, ctx, v, req));
/** Saves a version and runs the shortfall rule on it, as DEC-a's save does inside its transaction. */
const save = async (status: StoredDecisionStatus | null, questionId = 'Q-PP-01') => call(await version(status, questionId));
const shortfalls = (questionId: string) => testDb.finding.findMany({ where: { projectId: p.id, questionId, source: 'shortfall' } });
const findingRow = (id: string) => testDb.finding.findUniqueOrThrow({ where: { id } });

describe('onShortfallSaved and openShortfallForQuestion (FR-FND-01, SRS 5.3 item 11)', () => {
  it('FR-FND-01 UX-09: "not yet" opens exactly one finding; "partly" next keeps exactly one', async () => {
    await save('not_yet'); await save('partly');
    expect(await shortfalls('Q-PP-01')).toHaveLength(1);
    expect(await openShortfallForQuestion(ctx, p.id, 'Q-PP-01')).toEqual({ findingId: expect.any(String) });
  });

  it('FR-FND-01: after a risk accepted on "partly", another "partly" opens none and "not yet" opens one', async () => {
    const f = await save('partly'); await addAcceptedRisk(fx, f!.findingId, {});
    expect(await save('partly')).toBeNull();
    expect(await save('not_yet')).not.toBeNull();
    expect(await shortfalls('Q-PP-01')).toHaveLength(2);
  });

  it('FR-FND-01: after a risk accepted, a "done" version then "not yet" opens one', async () => {
    const f = await save('partly'); await addAcceptedRisk(fx, f!.findingId, {});
    expect(await save('done')).toBeNull(); expect(await save('not_yet')).not.toBeNull();
  });

  it('FR-FND-01: after a risk accepted on "not yet", "partly" and "not yet" open none (neither is worse)', async () => {
    const f = await save('not_yet'); await addAcceptedRisk(fx, f!.findingId, {});
    expect(await save('partly')).toBeNull();
    expect(await save('not_yet')).toBeNull();
    expect(await shortfalls('Q-PP-01')).toHaveLength(1);
  });

  it('FR-FND-01: "not applicable" saved after the acceptance also counts as fixed, so the next shortfall opens one', async () => {
    const f = await save('partly'); await addAcceptedRisk(fx, f!.findingId, {});
    await save('not_applicable');
    expect(await save('partly')).not.toBeNull();
  });

  it('FR-FND-01: a finding closed by a mitigation lets the next shortfall open a second finding', async () => {
    const f = await save('not_yet'); await addMitigationVersion(fx, f!.findingId, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
    expect(await save('not_yet')).not.toBeNull();
  });

  it('FR-FND-01 FR-FND-07: a reopened finding is open again, so the next shortfall opens none', async () => {
    const f = await save('partly'); await addAcceptedRisk(fx, f!.findingId, {});
    await addFindingEvent(fx, f!.findingId, { kind: 'reopened' });
    expect(await save('not_yet')).toBeNull();
    expect(await openShortfallForQuestion(ctx, p.id, 'Q-PP-01')).toEqual({ findingId: f!.findingId });
  });

  it('FR-FND-02 FR-FND-01: a team finding about the question never counts as its shortfall', async () => {
    await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', questionId: 'Q-PP-01' });
    expect(await openShortfallForQuestion(ctx, p.id, 'Q-PP-01')).toBeNull();
    expect(await save('partly')).not.toBeNull();
  });

  it('FR-FND-01: findings of another question are not this question\'s', async () => {
    await save('not_yet', 'Q-PP-02');
    expect(await openShortfallForQuestion(ctx, p.id, 'Q-PP-01')).toBeNull();
    expect(await save('not_yet')).not.toBeNull();
  });

  it('FR-FND-01 NFR-INT-02: the finding carries the derived request id and the request digest', async () => {
    const REQ = randomUUID();
    const v = await version('not_yet'); const out = await call(v, { requestId: REQ, digest: 'd'.repeat(64) });
    expect(await findingRow(out!.findingId)).toMatchObject({
      requestId: derivedRequestId(REQ, 'findings:' + v.id), requestDigest: 'd'.repeat(64), decisionVersionId: v.id, source: 'shortfall',
      questionId: 'Q-PP-01', stage: 'pre-processing', raisedById: fx.members.assessor.userId, title: null, description: null, riskArea: null,
    });
  });

  it('FR-FND-01: done, not applicable, a withdrawal and a gate answer open nothing', async () => {
    for (const s of ['done', 'not_applicable', 'withdrawn', null] as const) expect(await save(s)).toBeNull();
    expect(await testDb.finding.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('NFR-SEC-02: openShortfallForQuestion of another organisation reads nothing', async () => {
    await save('not_yet');
    const other = await buildOrg();
    expect(await openShortfallForQuestion(ctxFor(other, 'owner'), p.id, 'Q-PP-01')).toBeNull();
  });

  it('FR-FND-01 FR-FND-05: after "keep accepted", the status compared is the one current when it was recorded', async () => {
    const f = await save('not_yet'); await addAcceptedRisk(fx, f!.findingId, {});    // A1 on not yet
    expect(await save('partly')).toBeNull();                                         // not worse than not yet
    await addAcceptedRisk(fx, f!.findingId, {});                                     // A2, keep accepted: V_A is now the partly version
    expect(await save('not_yet')).not.toBeNull();                                    // worse than partly: a new finding
    expect(await shortfalls('Q-PP-01')).toHaveLength(2);
  });

  describe('a save racing an acceptance of the latest shortfall (F5, the per-finding lock)', () => {
    const assessor = () => ({ userId: fx.members.assessor.userId, role: 'assessor' as const });
    const admin = () => ({ userId: fx.members.admin.userId, role: 'admin' as const });
    const decide = (projectId: string, status: 'partly' | 'not_yet', baseVersionNumber: number | null) => {
      const b: SaveDecisionRequest = {
        requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber, status, scopeAnswer: null, optionsInPlace: [],
        reasonCode: status === 'not_yet' ? 'ny_planned_later' : null, reason: `Fixture reason for the race ${randomUUID().slice(0, 8)}`,
        decidedBy: { kind: 'member', userId: fx.members.assessor.userId }, declaredDate: '2026-10-12', evidenceIds: [],
      };
      return saveDecision(ctxFor(fx, 'assessor'), assessor(), { ...b, projectId }, requestDigest({ path: { id: projectId }, body: b }));
    };
    const accept = (projectId: string, findingId: string) => acceptRisk(ctxFor(fx, 'admin'), admin(), {
      requestId: randomUUID(), mode: 'accept', acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, reason: 'Accepted in the race',
      lookAgainOn: null, lookAgainNote: null, projectId, findingId,
    }, 'r'.repeat(64));
    const count = (projectId: string) => testDb.finding.count({ where: { projectId, source: 'shortfall' } });

    it('FR-FND-01 F5: "partly" saved while the risk is accepted on "not yet" never opens a second finding (10 runs)', async () => {
      for (let i = 0; i < 10; i++) {
        const pr = await addProject(fx);
        await decide(pr.id, 'not_yet', null);
        const L = (await openShortfallForQuestion(ctx, pr.id, 'Q-PP-01'))!;
        const r = await Promise.allSettled([decide(pr.id, 'partly', 1), accept(pr.id, L.findingId)]);
        expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await count(pr.id)).toBe(1);
      }
    });

    it('FR-FND-01 F5: "not yet" saved while the risk is accepted on "partly" opens at most one finding, raised by that save (10 runs)', async () => {
      for (let i = 0; i < 10; i++) {
        const pr = await addProject(fx);
        await decide(pr.id, 'partly', null);
        const L = (await openShortfallForQuestion(ctx, pr.id, 'Q-PP-01'))!;
        const r = await Promise.allSettled([decide(pr.id, 'not_yet', 1), accept(pr.id, L.findingId)]);
        expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
        // Save first: L was open, so none; acceptance first: not yet is worse than partly, so one. Never two, never another's.
        const v2 = await testDb.decisionVersion.findFirstOrThrow({ where: { projectId: pr.id, versionNumber: 2 } });
        const extra = await testDb.finding.findMany({ where: { projectId: pr.id, source: 'shortfall', id: { not: L.findingId } } });
        expect(extra.length).toBeLessThanOrEqual(1);
        expect(extra.every((x) => x.decisionVersionId === v2.id)).toBe(true);
      }
    });

    it('FR-FND-01 FR-FND-07 F5: "not yet" saved while its closed shortfall is reopened leaves exactly one open shortfall (10 runs)', async () => {
      for (let i = 0; i < 10; i++) {
        const pr = await addProject(fx);
        await decide(pr.id, 'not_yet', null);
        const L = (await openShortfallForQuestion(ctx, pr.id, 'Q-PP-01'))!;
        await addMitigationVersion(fx, L.findingId, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });   // closed
        const reopen = reopenFinding(ctxFor(fx, 'assessor'), assessor(), {
          requestId: randomUUID(), reason: 'Not fixed', eventCode: null, projectId: pr.id, findingId: L.findingId }, 'o'.repeat(64));
        const r = await Promise.allSettled([decide(pr.id, 'not_yet', 1), reopen]);
        if (r[0].status === 'rejected') throw r[0].reason;
        // Reopen first: the save sees L open and raises none. Save first: it raises one, and the reopen is refused.
        if (r[1].status === 'rejected') expect(r[1].reason).toMatchObject({ status: 409, code: 'finding_already_open' });
        const open = await Promise.all((await testDb.finding.findMany({ where: { projectId: pr.id, source: 'shortfall' } }))
          .map(async (x) => (await openShortfallForQuestion(ctx, pr.id, 'Q-PP-01'))?.findingId === x.id));
        expect(open.filter(Boolean)).toHaveLength(1);
        const states = await testDb.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM findings f WHERE f."projectId" = ${pr.id}
          AND (NOT EXISTS (SELECT 1 FROM mitigation_versions m WHERE m."findingId" = f.id)
               OR EXISTS (SELECT 1 FROM finding_events e WHERE e."findingId" = f.id AND e.kind = 'reopened'))`;
        expect(states[0].n).toBe(1);   // open = no mitigation yet, or reopened after its done one
      }
    });
  });
});
