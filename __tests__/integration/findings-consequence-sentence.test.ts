import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredDecisionStatus } from '@/types/record';
import type { ContentRef } from '@/types/api';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { onShortfallSaved } from '@/lib/data/findings';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addAcceptedRisk, addDecision, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * The decision card's line for Partly and Not yet with no open shortfall finding is the owner's sentence (ruled 15 Nov
 * 2026, 11:45, reworded by the owner at 14:30): "Saving ‘Partly’ raises a finding for this question, unless its last
 * finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable."
 * These cases pin that sentence against the
 * server's rule as it is (lib/data/findings.ts onShortfallSaved and raisesAfterAcceptance); nothing on the server changes.
 *
 * Cases the protected __tests__/integration/findings-shortfall.test.ts already pins, so not repeated here:
 * - accepted at Partly, then Partly opens none; then Not yet opens one ("after a risk accepted on "partly", another
 *   "partly" opens none and "not yet" opens one");
 * - accepted at Not yet, then Partly opens none ("after a risk accepted on "not yet", "partly" and "not yet" open none").
 * Its "a "done" version then "not yet" opens one" case cannot tell the Done since from Not yet being worse than the
 * accepted Partly, so the Done case below saves Partly after the Done.
 */

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

/** Saves a version of Q-PP-01 with the fixture builder and runs the shortfall rule on it, as DEC-a's save does in its transaction. */
async function save(status: StoredDecisionStatus): Promise<{ findingId: string } | null> {
  const v = await addDecision(fx, p.id, {
    stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: cv.contentVersionId, status,
    scopeAnswer: null, withdrawalCode: status === 'withdrawn' ? 'entered_in_error' : null,
  });
  const version = { id: v.id, projectId: p.id, stage: 'pre-processing' as const, questionId: 'Q-PP-01', status, enteredById: fx.members.assessor.userId };
  return withOrg(ctx, (tx) => onShortfallSaved(tx, ctx, version, { requestId: randomUUID(), digest: 'a'.repeat(64) }));
}
const shortfalls = () => testDb.finding.count({ where: { projectId: p.id, questionId: 'Q-PP-01', source: 'shortfall' } });

describe('the owner\'s consequence sentence against the raise rule (FR-FND-01, FR-FND-05)', () => {
  it('FR-FND-01: the card\'s words are the owner\'s sentence, verbatim, for Partly and Not yet', () => {
    expect(DECISION_FORM_COPY.consequence.raises('Partly')).toBe(
      'Saving ‘Partly’ raises a finding for this question, unless its last finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable.',
    );
    expect(DECISION_FORM_COPY.consequence.raises('Not yet')).toBe(
      'Saving ‘Not yet’ raises a finding for this question, unless its last finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable.',
    );
  });

  it('FR-FND-01 FR-FND-05: accepted at Partly, then a Done version, then Partly: "no version since was Done" fails, so a finding is raised', async () => {
    const f = await save('partly'); const risk = await addAcceptedRisk(fx, f!.findingId, {});
    // Review B M-r3-2: the Done version is received strictly after the risk (decision_versions is append-only, so its time is
    // not set afterwards: the save waits for the database's clock to pass the risk's, then the order is asserted). The version
    // the risk was accepted on is then the Partly one, and the raise comes from "a version since was Done", never from a tie.
    const { receivedAt } = await testDb.acceptedRisk.findUniqueOrThrow({ where: { id: risk.id }, select: { receivedAt: true } });
    const dbNow = async () => (await testDb.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now.getTime();
    while (await dbNow() <= receivedAt.getTime() + 1) await new Promise((r) => setTimeout(r, 2));
    expect(await save('done')).toBeNull();
    const done = await testDb.decisionVersion.findFirstOrThrow({ where: { projectId: p.id, questionId: 'Q-PP-01', status: 'done' }, select: { receivedAt: true } });
    expect(done.receivedAt.getTime()).toBeGreaterThan(receivedAt.getTime());
    expect(await save('partly')).not.toBeNull();
    expect(await shortfalls()).toBe(2);
  });

  it('the owner\'s "its last finding": an earlier finding accepted at Partly, the latest closed by a mitigation, then Partly: a finding is raised', async () => {
    const first = await save('partly'); await addAcceptedRisk(fx, first!.findingId, {});
    const latest = await save('not_yet');                // worse than the accepted Partly: raised
    expect(latest).not.toBeNull();
    await addMitigationVersion(fx, latest!.findingId, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    expect(await save('partly')).not.toBeNull();         // the last finding was not closed as an accepted risk
    expect(await shortfalls()).toBe(3);
  });

  it('the owner\'s "its last finding": an earlier finding accepted at Partly, the latest withdrawn as a mistake, then Partly: a finding is raised', async () => {
    const first = await save('partly'); await addAcceptedRisk(fx, first!.findingId, {});
    const latest = await save('not_yet');
    expect(latest).not.toBeNull();
    await addFindingEvent(fx, latest!.findingId, { kind: 'withdrawn' });
    expect(await save('partly')).not.toBeNull();
    expect(await shortfalls()).toBe(3);
  });

  it('FR-FND-01 FR-FND-05: accepted while the decision was withdrawn, then Partly: no level was accepted, so a finding is raised', async () => {
    const f = await save('partly');
    expect(await save('withdrawn')).toBeNull();          // a withdrawal leaves the finding open and raises nothing
    await addAcceptedRisk(fx, f!.findingId, {});        // accepted now: the version it was accepted on is the withdrawal
    expect(await save('partly')).not.toBeNull();
    expect(await shortfalls()).toBe(2);
  });
});
