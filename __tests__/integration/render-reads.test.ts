import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { loadProjectOverview, stageView } from '@/lib/data/projects';
import { openMitigationsByStage, ownerCannotAct, stageFollowUpCounts } from '@/lib/data/followup';
import { changedSinceSeal, listStageReviews } from '@/lib/data/reviews';
import { listSeals, sealStageReview } from '@/lib/data/seals';
import { withOrg } from '@/lib/data/tenant';
import { loadContent } from '@/lib/content/loader';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';
import { readStagePlanRows } from '@/lib/seal/reads';
import { eatDate } from '@/lib/followup/overdue';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addEvidence, addFinding, addFindingEvent, addMitigationVersion, addProject, addSealRow, addStageReview, buildOrg, ctxFor,
  type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';

/**
 * NFR-PERF-04 (SRS line 3207), FIX-12: S-10 and S-11 render on the server within 800 ms at the 95th percentile with ten
 * users. The pages' reads are narrowed; these tests hold them to two things.
 *
 *  - Same output. S-10's counts are the values the code before FIX-12 gave on this fixture, written out; its follow-up
 *    lists are openMitigationsByStage's and ownerCannotAct's (paths the change left alone) and its reviews
 *    listStageReviews'. Each review's latest seal and change are written out for a fixture holding every kind of review
 *    (changed, unchanged, never sealed, unreadable seal), each changed review with a change list of its own and an
 *    unchanged one sorted between two changed ones, so a review given another's changes shows; they also equal
 *    listSeals' first and changedSinceSeal's. S-11's newest review and change are changedSinceSeal's.
 *  - Fewer reads. The statements a page issues are counted through `withOrg` (the only path to tenant data): their
 *    number does not grow with the number of stage reviews or seals (no read per review), and none reads whole rows
 *    with `row_to_json` (the seal source form, which carries every column the comparison does not use).
 */

// Every statement issued through a `withOrg` transaction while `count.on`: raw SQL by its text, a model call by name.
const count = vi.hoisted(() => ({ on: false, statements: [] as string[] }));
vi.mock('@/lib/data/tenant', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/tenant')>();
  const note = (s: string) => { if (count.on) count.statements.push(s); };
  const wrap = <T extends object>(tx: T): T => new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return value;
      if (/^\$(query|execute)Raw/.test(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          note(prop.endsWith('Unsafe') ? String(args[0]) : (args[0] as readonly string[]).join('?'));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (value !== null && typeof value === 'object' && typeof (value as { findMany?: unknown }).findMany === 'function') {
        return new Proxy(value, {
          get(delegate, method, r) {
            const f = Reflect.get(delegate, method, r);
            return typeof f === 'function' ? (...args: unknown[]) => { note(`${prop}.${String(method)}`); return f.apply(delegate, args); } : f;
          },
        });
      }
      return value;
    },
  });
  return { ...real, withOrg: ((ctx, cb, options) => real.withOrg(ctx, (tx) => cb(wrap(tx)), options)) as typeof real.withOrg };
});
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x',
}));

const { loadStagePage } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/page');

let fx: OrgFixture;
let p: { id: string };
let cv: string;
const today = eatDate(new Date());
const ctx = () => ctxFor(fx, 'viewer');
const dec = (stage: Stage, questionId: string, more: Partial<FixtureDecision> = {}): FixtureDecision =>
  ({ stage, questionId, contentVersionId: cv, declaredDate: '2026-10-20', ...more });

async function seal(reviewId: string) {
  const out = await sealStageReview(ctxFor(fx, 'reviewer'), { userId: fx.members.reviewer.userId, role: 'reviewer' },
    { requestId: randomUUID(), projectId: p.id, reviewId }, randomUUID().replace(/-/g, '').padEnd(64, '0'));
  return out.value;
}

/** Statements issued by `f`, counted as above. */
async function statementsOf(f: () => Promise<unknown>): Promise<string[]> {
  count.statements = [];
  count.on = true;
  try {
    await f();
  } finally {
    count.on = false;
  }
  return count.statements;
}

const s10 = () => loadProjectOverview(ctx(), { orgSlug: fx.org.slug, projectId: p.id, today });
const s11 = () => loadStagePage(ctx(), fx.members.viewer.userId, p.id, 'pre-processing');

let reviews: Record<'changedTwice' | 'unchanged' | 'changedOnce' | 'neverSealed' | 'inChanged' | 'unreadable', { id: string }>;
let f1: { id: string };

beforeEach(async () => {
  count.on = false;
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  p = await addProject(fx);
  const ev = await addEvidence(fx, p.id, { kind: 'file' });
  const link = await addEvidence(fx, p.id, { kind: 'link', url: 'https://example.test/policy' });
  // pre-processing: a decision with evidence and a second version, a withdrawal, the gate answered no, a shortfall.
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-01', { evidenceIds: [ev.id] }));
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-01', { evidenceIds: [ev.id, link.id] }));
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-07'));
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-07', { status: 'withdrawn', withdrawalCode: 'entered_in_error' }));
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'no' }));
  const partly = await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-04', { status: 'partly' }));
  await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-04', decisionVersionId: partly.id });
  // findings with work: two mitigation versions (one overdue, owned by a role that cannot act), an accepted risk, a reopen.
  f1 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  const m = await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2026-01-10' });
  await addMitigationVersion(fx, f1.id, { mitigationId: m.mitigationId, status: 'in_progress', owner: 'viewer', dueDate: '2026-01-12', evidenceIds: [ev.id] });
  await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
  const f2 = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  await addAcceptedRisk(fx, f2.id, {});
  await addFindingEvent(fx, f2.id, { kind: 'reopened' });
  const f3 = await addFinding(fx, p.id, { stage: 'in-processing', source: 'team' });
  await addMitigationVersion(fx, f3.id, { status: 'planned', owner: 'assessor', dueDate: '2026-02-01' });
  await addDecision(fx, p.id, dec('in-processing', 'Q-IP-01'));
  await addDecision(fx, p.id, dec('post-processing', 'Q-PO-01'));

  // Reviews, each changed one with its own change list, and a sealed but unchanged review sorted between two changed
  // ones, so a review given another's change list, or a change list paired by position, shows (C4 SFH-1):
  //  - pre-processing review 1, sealed twice, then a new decision (Q-PP-03) and a new mitigation of f1: both changed;
  //  - pre-processing review 2, sealed after both changes: unchanged;
  //  - pre-processing review 3, sealed after the decision and before the mitigation: f1 changed only;
  //  - pre-processing review 4, never sealed;
  //  - in-processing review 1, sealed, then a new decision (Q-IP-02): Q-IP-02 changed only;
  //  - post-processing review 1, whose seal bytes are no manifest.
  const changedTwice = await addStageReview(fx, p.id, { stage: 'pre-processing', preparedFor: 'the board' });
  const unchanged = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  const changedOnce = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  const inChanged = await addStageReview(fx, p.id, { stage: 'in-processing' });
  await seal(changedTwice.id);
  await seal(changedTwice.id);
  await seal(inChanged.id);
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-03'));
  await addDecision(fx, p.id, dec('in-processing', 'Q-IP-02'));
  await seal(changedOnce.id);
  await addMitigationVersion(fx, f1.id, { status: 'planned', owner: 'assessor', dueDate: '2026-03-01' });
  await seal(unchanged.id);
  const neverSealed = await addStageReview(fx, p.id, { stage: 'pre-processing' });
  const unreadable = await addStageReview(fx, p.id, { stage: 'post-processing' });
  await addSealRow(fx, unreadable.id, { contentVersionId: cv });
  reviews = { changedTwice, unchanged, changedOnce, neverSealed, inChanged, unreadable };
});

/** Three more reviews of pre-processing, each sealed twice and then changed, so each has a seal and a change to compare. */
async function moreSealedReviews(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
    await seal(r.id);
    await seal(r.id);
  }
  await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-05', { status: 'not_yet' }));
}

describe('S-10 and S-11 give the same data (FIX-12)', () => {
  it('NFR-PERF-04 FR-REV-05 FIX-12: each review\'s latest seal and change are listSeals\' first and changedSinceSeal\'s, with the values of every kind of review', async () => {
    const views = await listStageReviews(ctx(), p.id);
    expect(views.map((v) => [v.stage, v.numberInStage])).toEqual([
      ['pre-processing', 1], ['pre-processing', 2], ['pre-processing', 3], ['pre-processing', 4], ['in-processing', 1], ['post-processing', 1],
    ]);
    for (const v of views) {
      expect(v.latestSeal).toEqual((await listSeals(ctx(), v.id))[0] ?? null);
      expect(v.changed).toEqual(await changedSinceSeal(ctx(), v.id));
      expect(v.changedSinceLatestSeal).toBe(v.changed !== null);
    }
    // Each review's own values, written out: every changed review has a change list no other review has.
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get(reviews.changedTwice.id)).toMatchObject({
      preparedFor: 'the board', latestSealUnreadable: false, latestSeal: { sealNumber: 2, bytesMatch: true },
      changed: { sealNumber: 2, changedQuestions: ['Q-PP-03'], changedFindings: [f1.id] },
    });
    expect(byId.get(reviews.unchanged.id)).toMatchObject({ latestSeal: { sealNumber: 1, bytesMatch: true }, changed: null, changedSinceLatestSeal: false, latestSealUnreadable: false });
    expect(byId.get(reviews.changedOnce.id)).toMatchObject({
      latestSealUnreadable: false, latestSeal: { sealNumber: 1 }, changed: { sealNumber: 1, changedQuestions: [], changedFindings: [f1.id] },
    });
    expect(byId.get(reviews.neverSealed.id)).toMatchObject({ latestSeal: null, changed: null, changedSinceLatestSeal: false, latestSealUnreadable: false });
    expect(byId.get(reviews.inChanged.id)).toMatchObject({
      latestSeal: { sealNumber: 1, bytesMatch: true }, changed: { sealNumber: 1, changedQuestions: ['Q-IP-02'], changedFindings: [] }, latestSealUnreadable: false,
    });
    expect(byId.get(reviews.unreadable.id)).toMatchObject({ latestSeal: { sealNumber: 1, bytesMatch: true }, changed: null, latestSealUnreadable: true });
    // One stage alone gives that stage's views, the same ones.
    expect(await listStageReviews(ctx(), p.id, 'pre-processing')).toEqual(views.filter((v) => v.stage === 'pre-processing'));
  });

  it('NFR-PERF-04 FR-PRJ-02 FR-FUP-01 FR-FUP-05 FIX-12: S-10\'s counts are the old code\'s, and its lists and reviews are the follow-up and review services\'', async () => {
    const data = await s10();
    // The counts the code before FIX-12 (29cf11ca) gave on this fixture, written out (C4 SFH-2): stageView now shares
    // S-10's reads, so comparing the two would compare the new code with itself.
    expect(data!.counts).toEqual({
      'pre-processing': { questions: 24, noDecision: 18, byStatus: { done: 2, partly: 1, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 1, openFindings: 3, openFindingsWithoutMitigation: 2, openMitigations: 3, overdueMitigations: 2, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 2 },
      'in-processing': { questions: 26, noDecision: 24, byStatus: { done: 2, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 2, openFindings: 1, openFindingsWithoutMitigation: 0, openMitigations: 1, overdueMitigations: 1, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0 },
      'post-processing': { questions: 28, noDecision: 27, byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 0 }, doneWithoutEvidence: 1, openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0, overdueMitigations: 0, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0 },
    });
    const kept = { includeArchived: true };
    const byStage = await openMitigationsByStage(ctx(), p.id, today, kept);
    const cannotAct = await ownerCannotAct(ctx(), p.id, kept);
    const reviewViews = await listStageReviews(ctx(), p.id);
    expect(data!.counts).toEqual(await stageView(ctx(), p.id, today));
    for (const s of STAGES) {
      expect(data!.followUp[s]).toEqual({ items: byStage[s].filter((i) => i.ownerCanAct), cannotAct: cannotAct.filter((i) => i.stage === s) });
      expect(data!.reviews[s]).toEqual(reviewViews.filter((r) => r.stage === s));
      const fu = await stageFollowUpCounts(ctx(), p.id, s, today, kept);
      expect([data!.counts[s].openFindings, data!.counts[s].overdueMitigations]).toEqual([fu.openFindings, fu.overdueMitigations]);
    }
    // The fixture reaches every list: an overdue item someone can act on, one whose owner cannot, and open findings.
    expect(data!.followUp['pre-processing'].items.length).toBeGreaterThan(0);
    expect(data!.followUp['pre-processing'].cannotAct.length).toBe(1);
    expect(data!.counts['pre-processing']).toMatchObject({ openFindings: 3, acceptedRisks: 0 });
  });

  it('NFR-PERF-04 FR-REV-05 FIX-12: S-11 names the stage\'s newest review and compares with its latest seal', async () => {
    const data = (await s11())!;
    expect(data.review).toEqual({ id: reviews.neverSealed.id, name: 'Pre-processing review 4' });
    expect(data.changed).toEqual(await changedSinceSeal(ctx(), reviews.neverSealed.id));
    expect(data.changed).toBeNull();
    await seal(reviews.neverSealed.id);
    await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-02'));
    const after = (await s11())!;
    expect(after.changed).toEqual({ sealNumber: 1, changedQuestions: ['Q-PP-02'], changedFindings: [] });
    expect(after.rows.find((r) => r.questionId === 'Q-PP-02')).toBeDefined();
  });

  it('NFR-PERF-04 FR-REV-05 FIX-12: the comparison\'s own rows plan the same ids as the seal\'s source rows', async () => {
    const content = loadContent('0.0.1-fixture');
    for (const stage of STAGES) {
      const [full, narrow] = await withOrg(ctx(), async (tx) => [await readStageRows(tx, p.id, stage), await readStagePlanRows(tx, p.id, stage)]);
      expect(stagePlan(narrow, { stage, content })).toEqual(stagePlan(full, { stage, content }));
    }
  });
});

describe('the narrowed reads stay in the organisation (FIX-12)', () => {
  it('NFR-SEC-02 NFR-PERF-04 FIX-12: another organisation reads none of the project\'s plan rows, reviews or seal comparisons', async () => {
    const other = ctxFor(await buildOrg(), 'owner');
    for (const stage of STAGES) {
      const rows = await withOrg(other, (tx) => readStagePlanRows(tx, p.id, stage));
      expect(Object.values(rows).every((t) => Array.isArray(t) && t.length === 0)).toBe(true);
    }
    expect(await listStageReviews(other, p.id)).toEqual([]);
    await expect(changedSinceSeal(other, reviews.changedTwice.id)).rejects.toThrow(/not found/);
    // The same reads in the project's own organisation do find them, so the empty answers above are the boundary.
    expect((await listStageReviews(ctx(), p.id)).length).toBe(6);
  });
});

describe('S-10 and S-11 read less (FIX-12)', () => {
  it('NFR-PERF-04 FIX-12: S-10 issues no more statements with three more sealed and changed reviews (no read per review)', async () => {
    const before = await statementsOf(s10);
    await moreSealedReviews();
    const after = await statementsOf(s10);
    expect(after.length, `NFR-PERF-04 FIX-12: S-10 must not read once per review or seal\n${after.join('\n')}`).toBe(before.length);
  });

  it('NFR-PERF-04 FIX-12: S-11 issues no more statements with three more sealed and changed reviews (no read per review)', async () => {
    // S-11 compares the newest review with its seal, so the newest is sealed and changed in both counts: only the number
    // of reviews and seals differs between them.
    await seal(reviews.neverSealed.id);
    await addDecision(fx, p.id, dec('pre-processing', 'Q-PP-02'));
    const before = await statementsOf(s11);
    await moreSealedReviews();
    const after = await statementsOf(s11);
    expect(after.length, `NFR-PERF-04 FIX-12: S-11 must not read once per review or seal\n${after.join('\n')}`).toBe(before.length);
  });

  it('NFR-PERF-04 FIX-12: S-10 reads the project\'s follow-up rows once and its findings once, not once per stage and list', async () => {
    const statements = await statementsOf(s10);
    // The follow-up source rows (lib/data/followup.ts) are the one read of current mitigation versions by DISTINCT ON.
    expect(statements.filter((s) => s.includes('DISTINCT ON ("mitigationId")')).length, 'NFR-PERF-04 FIX-12: S-10 reads its follow-up rows once').toBe(1);
    // One for those source rows and one for the findings S-10 counts (listFindings' records).
    expect(statements.filter((s) => s === 'finding.findMany').length, 'NFR-PERF-04 FIX-12: S-10 reads findings for its follow-up rows and its counts, once each').toBe(2);
  });

  it('NFR-PERF-04 FIX-12: neither page reads whole rows with row_to_json', async () => {
    for (const page of [s10, s11]) {
      const statements = await statementsOf(page);
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((s) => /row_to_json/.test(s)), 'NFR-PERF-04 FIX-12: whole-row reads are the seal builder\'s, not a page\'s').toEqual([]);
    }
  });
});
