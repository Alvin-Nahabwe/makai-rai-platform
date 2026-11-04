import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';
import { stageSnapshotIds } from '@/lib/seal/ids';
import { loadContent } from '@/lib/content/loader';
import { SEAL_SOURCE_TABLES, type SealSourceRows } from '@/lib/integrity/sealCheck.mjs';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addEvidence, addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor,
  type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';

/**
 * The seal's reads (SRS 5.3 item 9, NFR-INT-10): one REPEATABLE READ snapshot, so a seal never holds a decision
 * without the finding it raised. The pause runs K0a's fixture builder on its own connection (testDb) between the
 * builder's two reads; under a snapshot neither row is seen, at READ COMMITTED the second read sees the finding.
 */
const pause = vi.hoisted(() => ({ beforeFindings: null as null | (() => Promise<void>) }));
vi.mock('@/lib/seal/reads', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/seal/reads')>();
  return {
    ...real,
    readStageFindingRows: async (...args: Parameters<typeof real.readStageFindingRows>) => {
      const hook = pause.beforeFindings;
      pause.beforeFindings = null;
      if (hook) await hook();
      return real.readStageFindingRows(...args);
    },
  };
});

let fx: OrgFixture;
let ctx: OrgContext;
let p: { id: string };
let fv: { contentVersionId: string };

const dec = (questionId: string, over: Partial<FixtureDecision> = {}): FixtureDecision =>
  ({ stage: 'pre-processing', questionId, contentVersionId: fv.contentVersionId, declaredDate: '2026-10-20', ...over });
const hasVersion = (rows: SealSourceRows, id: string) => rows.decision_versions.some((r) => r.id === id);
const hasFinding = (rows: SealSourceRows, id: string) => rows.findings.some((r) => r.id === id);

/** A Partly version of Q-PP-01 and its shortfall finding, written on another connection. */
async function partlyWithFinding(): Promise<{ versionId: string; findingId: string }> {
  const v = await addDecision(fx, p.id, dec('Q-PP-01', { status: 'partly' }));
  const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: v.id });
  return { versionId: v.id, findingId: f.id };
}

beforeEach(async () => {
  await resetDb();
  fv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  ctx = ctxFor(fx, 'viewer');
  p = await addProject(fx);
  pause.beforeFindings = null;
});

describe('the seal reads (lib/seal/reads.ts, lib/seal/manifest.ts, lib/seal/ids.ts)', () => {
  it('NFR-INT-10: under a pause between reads, the repeatable-read reader sees neither the version nor its finding', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01'));
    let saved = { versionId: '', findingId: '' };
    pause.beforeFindings = async () => { saved = await partlyWithFinding(); };
    const rr = await withOrg(ctx, (tx) => readStageRows(tx, p.id, 'pre-processing'), { isolationLevel: 'RepeatableRead' });
    expect(saved.versionId).not.toBe('');
    expect(hasVersion(rr, saved.versionId)).toBe(false);
    expect(hasFinding(rr, saved.findingId)).toBe(false);

    // The control proves the case above can fail: at READ COMMITTED the second read sees the new finding.
    let saved2 = { versionId: '', findingId: '' };
    pause.beforeFindings = async () => { saved2 = await partlyWithFinding(); };
    const rc = await withOrg(ctx, (tx) => readStageRows(tx, p.id, 'pre-processing'));
    expect(hasVersion(rc, saved2.versionId)).toBe(false);
    expect(hasFinding(rc, saved2.findingId)).toBe(true);
  });

  it('FR-REV-05 (helper): stageSnapshotIds names the current versions, the gate-derived source and the stage findings, and changes after a new version', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01'));
    const v1 = (await addDecision(fx, p.id, dec('Q-PP-01'))).id;   // version 2 is current
    const v2 = (await addDecision(fx, p.id, dec('Q-PP-02', { status: 'partly' }))).id;
    const gateNo = (await addDecision(fx, p.id, dec('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' }))).id;
    await addDecision(fx, p.id, dec('Q-PP-13'));                      // answered before the gate said no: not the entry
    const f1 = (await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-02', decisionVersionId: v2 })).id;
    await addFinding(fx, p.id, { stage: 'in-processing', source: 'team' });   // another stage
    const before = await withOrg(ctx, (tx) => stageSnapshotIds(tx, p.id, 'pre-processing'));
    expect(before.decisionVersions).toEqual([v1, v2, gateNo].sort());
    expect(before.findings).toEqual([f1]);
    await addDecision(fx, p.id, dec('Q-PP-01'));
    expect(await withOrg(ctx, (tx) => stageSnapshotIds(tx, p.id, 'pre-processing'))).not.toEqual(before);
  });

  it('FR-REV-05 (5.3 items 2 and 11): the plan takes a withdrawal as current, the latest version per mitigation, every event, the latest accepted risk and only the chosen versions\' evidence', async () => {
    const e1 = await addEvidence(fx, p.id, { kind: 'file' });
    const e2 = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.org/a' });
    const e3 = await addEvidence(fx, p.id, { kind: 'file' });
    await addDecision(fx, p.id, dec('Q-PP-01', { evidenceIds: [e3.id] }));               // superseded: its evidence is not named
    const v1 = (await addDecision(fx, p.id, dec('Q-PP-01', { status: 'partly', evidenceIds: [e1.id] }))).id;
    await addDecision(fx, p.id, dec('Q-PP-02'));
    const w = (await addDecision(fx, p.id, dec('Q-PP-02', { status: 'withdrawn', withdrawalCode: 'entered_in_error', declaredDate: undefined }))).id;
    const f = (await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: v1 })).id;
    const m1 = await addMitigationVersion(fx, f, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const ar1 = await addAcceptedRisk(fx, f, {});
    const ev = await addFindingEvent(fx, f, { kind: 'reopened' });
    const m1b = await addMitigationVersion(fx, f, { mitigationId: m1.mitigationId, status: 'planned', owner: 'assessor', dueDate: '2026-12-15', evidenceIds: [e2.id] });
    const ar2 = await addAcceptedRisk(fx, f, {});
    const rows = await withOrg(ctx, (tx) => readStageRows(tx, p.id, 'pre-processing'), { isolationLevel: 'RepeatableRead' });
    expect(Object.keys(rows).sort()).toEqual([...SEAL_SOURCE_TABLES].sort());
    expect(rows.seals).toEqual([]);
    expect(String(rows.decision_versions[0].receivedAt)).toMatch(/\+00:00$/);   // row_to_json in a UTC session
    const plan = stagePlan(rows, { stage: 'pre-processing', content: loadContent('0.0.1-fixture') });
    expect(plan.ids.decisionVersions).toEqual([v1, w].sort());
    expect(plan.ids.evidence).toEqual([e1.id, e2.id].sort());
    expect(plan.ids.mitigationVersions).toEqual([m1b.id]);
    expect(plan.ids.acceptedRisks).toEqual([ar2.id]);
    expect(plan.ids.findingEvents).toEqual([ev.id]);
    expect(ar1.id).not.toBe(ar2.id);
    expect(plan.questions.find((q) => q.question === 'Q-PP-13')).toEqual({ question: 'Q-PP-13', derivedFrom: null });   // no gate answer: it applies
    expect(plan.questions.map((q) => q.question)).toEqual([...plan.questions.map((q) => q.question)].sort());
  });
});
