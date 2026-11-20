import { describe, expect, it } from 'vitest';
import type { DecisionStatus, Stage, UtcInstant } from '@/types/record';
import { STAGES } from '@/types/record';
import type { ContentRef, FindingView, UserRef } from '@/types/api';
import type { SealManifestV1 } from '@/types/seal';
import type { DraftRecord } from '@/lib/data/documents';
import { loadContent } from '@/lib/content/loader';
import { controlsForArea, questionAreaIds } from '@/lib/content/suggestions';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { GATE_DERIVED_NA, NO_RISK_AREA_GROUP, findingOnQuestion, docTextErasedLine, findingOnRemovedQuestion, wordsThenCode } from '@/lib/documents/copy';
import { resolveFields, type DocumentSnapshot, type SealedDecision, type SealedFinding, type SnapshotStage } from '@/lib/documents/resolve';
import { buildWorkingReportSummary, type AreaGroup, type OpenItem } from '@/lib/documents/workingReport';
import { contentWith } from '../helpers/contentWith';

/**
 * Task 7 (path to outputs): page 1's summary is a pure function of a draft record and the running content. The records are built by hand
 * over the fixture bundle. Design G1, §4 anti-goal 3, §7; the controller's calls 6, 7 and 9; conflicts 19 and 23.
 */

const plain = loadContent('0.0.1-fixture');
const approved = contentWith({ controlSuggestionsApproved: true });
const unapproved = contentWith({});
const CV: ContentRef = { contentVersionId: 'cv1', semver: '0.0.1-fixture', contentHash: 'h' };
const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });
const TAKEN: UtcInstant = '2026-11-19T14:05:09.000Z';
const NA_CODE = plain.reasonCodes.filter((c) => c.status === 'not_applicable')[0];
const stageOf = (qid: string): Stage => (plain.questions.get(qid) as { stage: Stage }).stage;
const areaWords = (id: string): string => wordsThenCode((plain.areas.get(id) as { name: string }).name, id);

function decision(qid: string, status: DecisionStatus | null = 'done', over: { optionsInPlace?: string[]; scopeAnswer?: 'yes' | 'no' | 'not_sure' | null } = {}): SealedDecision {
  return {
    row: {
      id: `dv-${qid}-1`, orgId: 'o', projectId: 'p', stage: stageOf(qid), questionId: qid, contentVersionId: 'cv1', versionNumber: 1, baseVersionNumber: null,
      status, scopeAnswer: over.scopeAnswer ?? null, optionsInPlace: over.optionsInPlace ?? [],
      reasonCode: status === 'not_applicable' ? NA_CODE.code : null, reason: status === 'not_applicable' ? 'Whole register used.' : null,
      reasonSalt: null, decidedByUserId: 'u-Amina N.', decidedByRole: null, declaredOn: new Date('2026-10-12T00:00:00Z'), declaredPrecision: 'day',
      withdrawalCode: null, enteredById: 'u-enterer', enteredByRole: 'assessor', receivedAt: new Date('2026-10-30T09:00:00Z'), requestId: 'r',
      requestDigest: 'd', evidenceIds: [],
    },
    content: CV, enteredBy: user('Amina N.'), decidedBy: { kind: 'member', user: user('Amina N.') }, evidence: [], reasonErased: null,
  };
}

type FindingSpec = {
  id: string; stage: Stage; source?: 'shortfall' | 'team'; questionId?: string | null; riskArea?: string | null; title?: string | null;
  state?: FindingView['state']; reason?: string;
};
function finding(s: FindingSpec): SealedFinding {
  const view: FindingView = {
    id: s.id, projectId: 'p', stage: s.stage, source: s.source ?? 'team', questionId: s.questionId ?? null, decisionVersionId: null,
    riskArea: s.riskArea ?? null, title: s.title === undefined ? (s.source === 'shortfall' ? null : 'A team finding') : s.title, description: 'Described.',
    raisedBy: user('Amina N.'), raisedAt: '2026-10-29T08:00:00.000Z', state: s.state ?? 'open', openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0,
  };
  const acceptedRisk = s.state === 'closed_accepted_risk'
    ? { id: `ar-${s.id}`, findingId: s.id, acceptedBy: { kind: 'member' as const, user: user('Amina N.') }, accepterRole: 'owner' as const, reason: s.reason ?? null,
      lookAgainNote: null, lookAgainOn: null, enteredBy: user('Amina N.'), enteredByRole: 'owner' as const, findingSeq: 3, receivedAt: TAKEN, erasedFields: [] }
    : null;
  return { finding: view, mitigations: [], acceptedRisk, events: [] };
}

type StageSpec = { decisions?: SealedDecision[]; findings?: SealedFinding[]; derived?: Record<string, string> };
function stage(st: Stage, s: StageSpec = {}): SnapshotStage {
  const decisions = new Map((s.decisions ?? []).map((d) => [d.row.questionId, d]));
  return {
    stage: st,
    seal: { kind: 'draft', key: `draft:${st}`, takenAt: TAKEN, enteredByPeople: decisions.size === 0 ? 0 : 1, openReview: null, lastSealedReview: null },
    preparedFor: null,
    manifest: { format: 'makrai.seal/1', content: { semver: '0.0.1-fixture', contentHash: 'h' }, decisions: [] } as unknown as SealManifestV1,
    decisions, derived: new Map(Object.entries(s.derived ?? {})), findings: s.findings ?? [],
  };
}

function record(specs: Partial<Record<Stage, StageSpec>>, over: Partial<DraftRecord> = {}): DraftRecord {
  const stages = Object.fromEntries(STAGES.map((st) => [st, stage(st, specs[st])])) as Record<Stage, SnapshotStage>;
  return {
    takenAt: TAKEN, stages, stagesWithAnswers: STAGES.filter((st) => stages[st].decisions.size > 0), contents: new Map([['cv1', plain]]),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: '2026-11-19',
    erasures: { evidence: new Map(), findings: new Map(), mitigation_versions: new Map(), accepted_risks: new Map(), stage_reviews: new Map() },
    developmentStage: null, omittedAnswers: 0, recordedQuestionWords: new Map(), ...over,
  };
}

/** The snapshot a stage's draft mitigation plan reads. */
const planSnap = (r: DraftRecord, st: Stage): DocumentSnapshot => ({
  provenance: { kind: 'draft', takenAt: TAKEN, omittedAnswers: 0, recordedQuestionWords: r.recordedQuestionWords }, documentType: 'mitigation_plan', reviewStage: st,
  chosen: r.stages[st], stages: r.stages, contents: r.contents, project: r.project, organisationName: r.organisationName, today: r.today, erasures: r.erasures,
});

const CHECKLIST = 'Q-PP-16';
const optionsOf = (qid: string): string[] => [...(plain.questions.get(qid)?.options ?? [])];
const allBut = (qid: string, ...unticked: string[]): string[] => optionsOf(qid).filter((o) => !unticked.includes(o));
const items = (g: AreaGroup[]): OpenItem[] => g.flatMap((x) => x.items);
const ids = (xs: OpenItem['controls']): string[] => xs.map((c) => c.id);

/** A project with answers in the first stage: two items under PP-04, one under PP-02, a team item under PP-03 in a stage with no answers, a no-area team item, an accepted risk, one thing in place, one that does not apply. */
function typical(): DraftRecord {
  return record({
    'pre-processing': {
      decisions: [
        decision('Q-PP-GATE-SENSITIVE', null, { scopeAnswer: 'no' }),
        decision('Q-PP-09', 'partly'), decision('Q-PP-03', 'not_yet'), decision('Q-PP-10', 'partly'), decision('Q-PP-12', 'done'), decision('Q-PP-08', 'not_applicable'),
        decision(CHECKLIST, 'partly', { optionsInPlace: allBut(CHECKLIST, 'Distribution analysis across subgroups', 'Data lineage/provenance tracking') }),
      ],
      findings: [
        finding({ id: 'f-09', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-09' }),
        finding({ id: 'f-03', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-03' }),
        finding({ id: 'f-16', stage: 'pre-processing', source: 'shortfall', questionId: CHECKLIST }),
        finding({ id: 'f-10', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-10', state: 'closed_accepted_risk', reason: 'Costs more than the study can bear.' }),
        finding({ id: 'f-none', stage: 'pre-processing', title: 'Nobody owns the consent forms' }),
      ],
      derived: { 'Q-PP-13': 'dv-Q-PP-GATE-SENSITIVE-1' },
    },
    'in-processing': { findings: [finding({ id: 'f-team-ip', stage: 'in-processing', riskArea: 'PP-03', title: 'Labels drift' })] },
  });
}

describe('buildWorkingReportSummary (Task 7)', () => {
  it('page 1 lists the same open items as the draft mitigation plans of the stages with answers', () => {
    const r = typical();
    const s = buildWorkingReportSummary(r, plain);
    const mp3Only = { ...loadFieldMap('mitigation_plan'), fields: loadFieldMap('mitigation_plan').fields.filter((f) => f.fieldId === 'MP-03') };
    const fromPlans = r.stagesWithAnswers.map((st) => resolveFields(mp3Only, planSnap(r, st), {}));
    // Both halves come from the resolver: the titles from MP-03's text, the ids from the finding rows MP-03 names as its sources.
    const titles = fromPlans.flatMap((res) => {
      const lines = (res.fields[0].text ?? '').split('\n');
      return lines.flatMap((l, k) => (/^\d+\. /.test(l) && /^Mitigation/.test(lines[k + 1] ?? '') ? [l.replace(/^\d+\. /, '')] : []));
    });
    const planIds = fromPlans.flatMap((res) => res.sources.filter((x) => x.sourceTable === 'findings').map((x) => x.sourceId));
    const onPage = items(s.nextSteps).filter((i) => r.stagesWithAnswers.includes(i.stage));
    expect(titles.length).toBeGreaterThan(0);
    expect(onPage.map((i) => i.title).sort()).toEqual([...titles].sort());
    expect(planIds.length).toBeGreaterThan(0);
    expect(onPage.map((i) => i.findingId).sort()).toEqual([...new Set(planIds)].sort());
  });

  it('a team finding open in a stage with no answers is on page 1 and in no draft plan', () => {
    const r = typical();
    expect(r.stagesWithAnswers).not.toContain('in-processing');
    const { nextSteps } = buildWorkingReportSummary(r, plain);
    const onPage = items(nextSteps).find((i) => i.findingId === 'f-team-ip');
    expect(onPage?.stage).toBe('in-processing');
    expect(onPage?.title).toBe('Labels drift');
    expect(nextSteps.find((g) => g.items.includes(onPage as OpenItem))?.areaId).toBe('PP-03');
  });

  it('an answer whose finding was closed by an accepted risk shows under Risk accepted with its reason', () => {
    const s = buildWorkingReportSummary(typical(), plain);
    expect(s.riskAccepted).toEqual([{
      findingId: 'f-10', title: findingOnQuestion(plain.questions.get('Q-PP-10')?.text as string, 'Q-PP-10'), reason: 'Costs more than the study can bear.',
      areaName: areaWords('PP-02'),
    }]);
    expect(items(s.nextSteps).map((i) => i.findingId)).not.toContain('f-10');
  });

  it("a checklist item sits under the first area of its unticked options and lists only that area's controls", () => {
    const s = buildWorkingReportSummary(typical(), approved);
    const group = s.nextSteps.find((g) => g.items.some((i) => i.findingId === 'f-16')) as AreaGroup;
    expect(group.areaId).toBe('PP-04');
    const item = group.items.find((i) => i.findingId === 'f-16') as OpenItem;
    expect(item.alsoAreas).toEqual([areaWords('PP-05'), areaWords('PO-07')]);
    const own = controlsForArea(approved, 'PP-04')[0].controls.map((c) => c.control.id);
    expect(ids(item.controls)).toEqual(own);
    expect(ids(item.controls)).not.toContain('C-08');
    expect(ids(item.controls)).not.toContain('C-28');
    expect(item.answer).toBe('Partly');
  });

  it("an item under one area never lists another area's controls", () => {
    // Every answerable question answered Partly with a finding, and a team finding on an area: the fully answered fixture.
    const every = [...plain.questions.values()].filter((q) => q.type !== 'gate');
    const specs: Partial<Record<Stage, StageSpec>> = {};
    for (const st of STAGES) {
      const qs = every.filter((q) => q.stage === st);
      specs[st] = {
        decisions: qs.map((q) => decision(q.id, 'partly')),
        findings: [...qs.map((q) => finding({ id: `f-${q.id}`, stage: st, source: 'shortfall', questionId: q.id })), finding({ id: `t-${st}`, stage: st, riskArea: 'IP-03' })],
      };
    }
    const s = buildWorkingReportSummary(record(specs), approved);
    let listed = 0;
    for (const g of s.nextSteps) {
      expect(g.areaId).not.toBeNull();
      const own = new Set((approved.areas.get(g.areaId as string)?.controls ?? []));
      for (const i of g.items) {
        for (const c of i.controls) expect(own.has(c.id), `${i.findingId} under ${g.areaId} lists ${c.id}`).toBe(true);
        listed += i.controls.length;
      }
    }
    expect(listed).toBeGreaterThan(0);
    // Non-vacuous: PP-04's own control C-07 is listed in the PP-04 group and in no other group.
    const withC07 = s.nextSteps.filter((g) => g.items.some((i) => ids(i.controls).includes('C-07'))).map((g) => g.areaId);
    expect(withC07).toEqual(['PP-04']);
  });

  it('anti-goal 3: no control is listed while the content has no approved mapping', () => {
    const off = buildWorkingReportSummary(typical(), unapproved);
    expect(off.controlsShown).toBe(false);
    expect(items(off.nextSteps).length).toBeGreaterThan(0);
    expect(items(off.nextSteps).every((i) => i.controls.length === 0)).toBe(true);
    const on = buildWorkingReportSummary(typical(), approved);
    expect(on.controlsShown).toBe(true);
    expect(items(on.nextSteps).some((i) => i.controls.length > 0)).toBe(true);
  });

  it('areas are ordered by open items, most first; the null group is last', () => {
    const s = buildWorkingReportSummary(typical(), plain);
    expect(s.nextSteps.map((g) => [g.areaId, g.items.length])).toEqual([['PP-04', 2], ['PP-02', 1], ['PP-03', 1], [null, 1]]);
    expect(s.nextSteps[3].areaName).toBe(NO_RISK_AREA_GROUP);
    expect(s.nextSteps[3].items[0].findingId).toBe('f-none');
    expect(s.nextSteps[0].areaName).toBe(areaWords('PP-04'));
  });

  it('a question with several areas is listed once, under its heading area, with the others in alsoAreas', () => {
    const s = buildWorkingReportSummary(typical(), plain);
    const hits = items(s.nextSteps).filter((i) => i.findingId === 'f-09');
    expect(hits).toHaveLength(1);
    expect(s.nextSteps.find((g) => g.items.includes(hits[0]))?.areaId).toBe('PP-02');
    expect(hits[0].alsoAreas).toEqual([areaWords('PP-04')]);
    expect(hits[0].questionText).toBe(plain.questions.get('Q-PP-09')?.text);
    expect(hits[0].answer).toBe('Partly');
  });

  it('a checklist with every option ticked but still an open finding falls back to the first of its areas', () => {
    const r = record({ 'pre-processing': {
      decisions: [decision(CHECKLIST, 'partly', { optionsInPlace: optionsOf(CHECKLIST) })],
      findings: [finding({ id: 'f-all', stage: 'pre-processing', source: 'shortfall', questionId: CHECKLIST })],
    } });
    const s = buildWorkingReportSummary(r, approved);
    expect(s.nextSteps.map((g) => g.areaId)).toEqual([questionAreaIds(approved, CHECKLIST)[0]]);
    expect(s.nextSteps.some((g) => g.areaId === null)).toBe(false);
    expect(s.nextSteps[0].items[0].controls.length).toBeGreaterThan(0);
  });

  it('In place and Does not apply list the answers; the gate question is never an item, in place or not applicable', () => {
    const r = typical();
    // A gate decision carrying a done status must still not be listed.
    (r.stages['pre-processing'].decisions as Map<string, SealedDecision>).set('Q-PP-GATE-SENSITIVE', decision('Q-PP-GATE-SENSITIVE', 'done', { scopeAnswer: 'no' }));
    const s = buildWorkingReportSummary(r, plain);
    expect(s.inPlace).toEqual([{ stage: 'pre-processing', questionId: 'Q-PP-12', questionText: plain.questions.get('Q-PP-12')?.text }]);
    expect(s.doesNotApply.map((d) => d.questionId)).toEqual(['Q-PP-08', 'Q-PP-13']);
    expect(s.doesNotApply[0].why).toBe(`Not applicable (${NA_CODE.label}). Reason: 'Whole register used.'`);
    expect(s.doesNotApply[1].why).toBe(GATE_DERIVED_NA);
    const everyQuestion = [...items(s.nextSteps).map((i) => i.questionId), ...s.inPlace.map((x) => x.questionId), ...s.doesNotApply.map((x) => x.questionId)];
    expect(everyQuestion).not.toContain('Q-PP-GATE-SENSITIVE');
  });

  it('a finding on a question the content no longer holds still appears, under its recorded wording', () => {
    const r = record({ 'pre-processing': { decisions: [decision('Q-PP-09', 'partly')], findings: [
      finding({ id: 'f-gone', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-GONE' }),
      finding({ id: 'f-gone2', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-GONE2' }),
    ] } }, { recordedQuestionWords: new Map([['f-gone', 'Is the old thing documented?']]) });
    const found = items(buildWorkingReportSummary(r, plain).nextSteps);
    const a = found.find((i) => i.findingId === 'f-gone') as OpenItem;
    const b = found.find((i) => i.findingId === 'f-gone2') as OpenItem;
    expect(a.title).toBe(findingOnQuestion('Is the old thing documented?', 'Q-PP-GONE'));
    expect(a.questionText).toBe('Is the old thing documented?');
    expect(b.title).toBe(findingOnRemovedQuestion('Q-PP-GONE2'));
    expect(b.questionText).toBeNull();
    expect(a.controls).toEqual([]);
  });

  it('omittedAnswers is carried from the record', () => {
    expect(buildWorkingReportSummary(record({}, { omittedAnswers: 3 }), plain).omittedAnswers).toBe(3);
    expect(buildWorkingReportSummary(typical(), plain).omittedAnswers).toBe(0);
  });

  it('Review Focus 5: no answers gives empty lists', () => {
    const s = buildWorkingReportSummary(record({}), approved);
    expect(s).toEqual({
      takenAt: TAKEN, controlsShown: true, omittedAnswers: 0, nextSteps: [], riskAccepted: [], inPlace: [], doesNotApply: [],
    });
  });

  it('a notebook link is given only for a control with a released notebook', () => {
    const s = buildWorkingReportSummary(typical(), approved);
    const controls = items(s.nextSteps).flatMap((i) => i.controls);
    const c03 = controls.find((c) => c.id === 'C-03');
    expect(c03?.notebookHref).toMatch(/^\/notebooks\/C-03_.*\.ipynb$/);
    expect(controls.some((c) => c.notebookHref === null)).toBe(true);
  });

  it('an accepted risk with no reason and no tombstone fails page 1 exactly as the draft plan does (parity, not a chosen behaviour)', () => {
    const r = record({ 'pre-processing': { decisions: [decision('Q-PP-10', 'partly')], findings: [
      finding({ id: 'f-bad', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-10', state: 'closed_accepted_risk' }),
    ] } });
    const plan = (): unknown => resolveFields(loadFieldMap('mitigation_plan'), planSnap(r, 'pre-processing'), {});
    expect(plan).toThrow(/accepted_risks ar-f-bad has no reason and no tombstone/);
    expect(() => buildWorkingReportSummary(r, plain)).toThrow(/accepted_risks ar-f-bad has no reason and no tombstone/);
  });

  it('an erased reason and an erased title print on page 1 as the draft plan prints them', () => {
    const r = record({ 'pre-processing': { decisions: [decision('Q-PP-10', 'partly')], findings: [
      finding({ id: 'f-er', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-10', state: 'closed_accepted_risk' }),
      finding({ id: 'f-t', stage: 'pre-processing', title: null }),
    ] } }, { erasures: {
      evidence: new Map(), findings: new Map([['f-t', new Map([['title', '2026-11-01']])]]), mitigation_versions: new Map(),
      accepted_risks: new Map([['ar-f-er', new Map([['reason', '2026-11-02']])]]), stage_reviews: new Map(),
    } });
    const s = buildWorkingReportSummary(r, plain);
    const text = (resolveFields(loadFieldMap('mitigation_plan'), planSnap(r, 'pre-processing'), {}).fields.find((f) => f.fieldId === 'MP-06')?.text) ?? '';
    expect(s.riskAccepted[0].reason).toBe(docTextErasedLine('2026-11-02'));
    expect(text).toContain(`Reason: ${s.riskAccepted[0].reason}`);
    expect(items(s.nextSteps).find((i) => i.findingId === 'f-t')?.title).toBe(docTextErasedLine('2026-11-01'));
  });
});
