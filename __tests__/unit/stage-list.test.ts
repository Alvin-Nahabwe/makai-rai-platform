import { describe, expect, it } from 'vitest';
import { buildStageRows, filterCounts, filterLabel, moduleGroups, retryAllSummary, stageDraftIds, STAGE_FILTERS } from '@/lib/question/stageList';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';

/** S-11's rows and filters (W-2, SRS lines 1785-1830; FR-DEC-03, FR-CNT-04, FR-CNT-08, UX-06, UX-26). */
const q = (id: string, extra: Partial<LoadedQuestion> = {}): LoadedQuestion => ({
  id, type: 'likert-5', text: `${id} text`, principle: 'P', gaps: [], expectedPractice: 'e', whyAsked: 'w', reasonPrompt: 'r', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M2', moduleTitle: 'Data Collection & Preparation', order: 0, ...extra,
});
const QUESTIONS = [
  q('Q-PP-01', { moduleId: 'M1', moduleTitle: 'Problem Formulation' }),
  q('Q-PP-GATE-SENSITIVE', { type: 'gate' }),
  q('Q-PP-13', { condition: { questionId: 'Q-PP-GATE-SENSITIVE', value: 'yes' } }),
  q('Q-PP-16', { type: 'checklist', options: ['A', 'B', 'C', 'D'] }),
];
const v = (questionId: string, over: Partial<DecisionVersionView> = {}): DecisionVersionView => ({
  id: `dv-${questionId}`, projectId: 'p1', stage: 'pre-processing', questionId, versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'done', scopeAnswer: null, optionsInPlace: [],
  reasonCode: null, reason: 'r', reasonErased: null, decidedBy: null, declaredDate: '2026-10-12', declaredPrecision: 'day', withdrawalCode: null,
  enteredBy: { userId: 'u', name: 'U', formerMember: false }, enteredByRole: 'assessor', receivedAt: '2026-10-12T07:42:00.000Z', evidence: [], ...over,
});
const BASE = { questions: QUESTIONS, current: new Map<string, DecisionVersionView>(), gate: null, openFindingsByQuestion: new Map<string, number>(), changed: [] as string[], reworded: [] as string[] };

describe('S-11 rows', () => {
  it('FR-DEC-06 (screen): with nothing recorded every row reads No decision', () => {
    const rows = buildStageRows(BASE);
    expect(rows.map((r) => r.statusText)).toEqual(['No decision', 'No decision', 'No decision', 'No decision']);
    expect(filterCounts(rows, new Set())).toMatchObject({ all: 4, no_decision: 4, shortfalls: 0, done_without_evidence: 0 });
  });

  it('FR-DEC-03 (screen): a withdrawal as current version reads No decision and counts under no decision', () => {
    const rows = buildStageRows({ ...BASE, current: new Map([['Q-PP-01', v('Q-PP-01', { versionNumber: 3, status: 'withdrawn', declaredDate: null })]]) });
    expect(rows[0]).toMatchObject({ statusText: 'No decision', versionNumber: 3, declaredDate: null });
    expect(filterCounts(rows, new Set()).no_decision).toBe(rows.length);
  });

  it('FR-CNT-08: the reworded filter counts the decisions answered against older wording', () => {
    const current = new Map([['Q-PP-01', v('Q-PP-01')], ['Q-PP-16', v('Q-PP-16', { status: 'partly', optionsInPlace: ['B'] })]]);
    const rows = buildStageRows({ ...BASE, current, reworded: ['Q-PP-01'] });
    expect(filterCounts(rows, new Set()).reworded).toBe(1);
    expect(rows.find((r) => r.questionId === 'Q-PP-01')!.reworded).toBe(true);
  });

  it('FR-CNT-04 (screen): the gate shows its scope answer; with the gate at no, Q-PP-13 reads Not applicable (scope answer: no)', () => {
    const rows = buildStageRows({ ...BASE, gate: 'no', current: new Map([['Q-PP-GATE-SENSITIVE', v('Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'no' })]]) });
    expect(rows.find((r) => r.questionId === 'Q-PP-GATE-SENSITIVE')!.statusText).toBe('Scope answer: no');
    expect(rows.find((r) => r.questionId === 'Q-PP-13')!.statusText).toBe('Not applicable (scope answer: no)');
    expect(filterCounts(rows, new Set()).no_decision).toBe(2);   // Q-PP-01 and Q-PP-16; the gate is answered and Q-PP-13 does not apply
  });

  it('FR-CNT-03 (screen): a checklist shows how many of its options are in place, as a count', () => {
    const rows = buildStageRows({ ...BASE, current: new Map([['Q-PP-16', v('Q-PP-16', { status: 'partly', optionsInPlace: ['A', 'C'] })]]) });
    expect(rows.find((r) => r.questionId === 'Q-PP-16')!.inPlace).toEqual({ n: 2, of: 4 });
  });

  it('W-2: shortfalls are Partly and Not yet; done without evidence; changed since seal; drafts on this device', () => {
    const current = new Map([
      ['Q-PP-01', v('Q-PP-01', { status: 'done' })],
      ['Q-PP-16', v('Q-PP-16', { status: 'not_yet', reasonCode: 'ny_planned_later' })],
      ['Q-PP-13', v('Q-PP-13', { status: 'done', evidence: [{ id: 'e1' } as DecisionVersionView['evidence'][number]] })],
    ]);
    const rows = buildStageRows({ ...BASE, current, changed: ['Q-PP-13'], openFindingsByQuestion: new Map([['Q-PP-16', 1]]) });
    expect(filterCounts(rows, new Set(['Q-PP-01', 'Q-PP-GATE-SENSITIVE']))).toEqual({
      all: 4, no_decision: 1, shortfalls: 1, done_without_evidence: 1, changed_since_seal: 1, reworded: 0, drafts: 2,
    });
    expect(rows.find((r) => r.questionId === 'Q-PP-16')!.openFindings).toBe(1);
  });

  it('W-2: every filter has its label', () => {
    expect(STAGE_FILTERS.map((f) => filterLabel(f, 1))).toEqual([
      'All', 'No decision', 'Shortfalls', 'Done without evidence', 'Changed since seal 1', 'Expected practice reworded since the decision', 'Drafts on this device',
    ]);
  });

  it('F1 FR-RM-04 UX-26: the drafts filter counts drafts of this stage only, when the device holds drafts in two stages', () => {
    const rows = buildStageRows(BASE);
    const listed = ['Q-PP-01', 'Q-IP-03', 'Q-PO-01'];   // one draft here, two in other stages of the same project
    expect([...stageDraftIds(listed, rows)]).toEqual(['Q-PP-01']);
    expect(filterCounts(rows, stageDraftIds(listed, rows)).drafts).toBe(1);
  });

  it('F6 7.4.1: Retry all says how many were saved and how many were not', () => {
    expect(retryAllSummary(['M-03', 'M-04'])).toBe('2 saved.');
    expect(retryAllSummary(['M-03', 'M-05', 'M-09'])).toBe('1 of 3 saved. 2 not saved: see each question.');
    expect(retryAllSummary(['M-05'])).toBe('0 of 1 saved. 1 not saved: see each question.');
  });

  it('SPEC-4 W-2: rows are grouped by module, each with its question count and to-do count', () => {
    const groups = moduleGroups(buildStageRows({ ...BASE, current: new Map([['Q-PP-GATE-SENSITIVE', v('Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'yes' })]]) }));
    expect(groups.map((g) => [g.moduleTitle, g.rows.length, g.noDecision])).toEqual([
      ['Problem Formulation', 1, 1],
      ['Data Collection & Preparation', 3, 2],
    ]);
  });
});
