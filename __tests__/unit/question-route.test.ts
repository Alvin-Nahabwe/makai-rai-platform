import { describe, expect, it } from 'vitest';
import { stopsOf, tallyOfRows } from '@/lib/question/route';
import { tallyWords } from '@/lib/ui/copy';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';

/** Plan 1C Task 2: a stage as a row of marks (spec 7.2): its stops and its tally, from the stage's rows and marks. */
const row = (questionId: string, over: Partial<StageRow> = {}): StageRow => ({
  questionId, questionType: 'likert-5', text: `${questionId} text`, moduleId: 'M1', moduleTitle: 'Problem Formulation', statusText: 'No decision',
  versionNumber: null, declaredDate: null, openFindings: 0, changedSinceSeal: false, reworded: false, inPlace: null, kind: 'none', evidenceCount: 0, ...over,
});

describe('stopsOf', () => {
  const rows = [row('Q-PP-02', { kind: 'done', evidenceCount: 1 }), row('Q-PP-01', { kind: 'shortfall' }), row('Q-PP-GATE', { questionType: 'gate', kind: 'scope' })];
  const marks: Record<string, StatusMarkKind> = { 'Q-PP-02': 'done', 'Q-PP-01': 'partly', 'Q-PP-GATE': 'scope_answered' };
  const hrefOf = (id: string) => `/q/${id}`;

  it('one stop per row, in row order, with its kind, the question text as title, its address and current', () => {
    expect(stopsOf(rows, marks, hrefOf, 'Q-PP-01')).toEqual([
      { id: 'Q-PP-02', kind: 'done', title: 'Q-PP-02 text', href: '/q/Q-PP-02', current: false },
      { id: 'Q-PP-01', kind: 'partly', title: 'Q-PP-01 text', href: '/q/Q-PP-01', current: true },
      { id: 'Q-PP-GATE', kind: 'scope_answered', title: 'Q-PP-GATE text', href: '/q/Q-PP-GATE', current: false },
    ]);
  });

  it('without a current question no stop is current', () => {
    expect(stopsOf(rows, marks, hrefOf).every((s) => s.current === false)).toBe(true);
  });

  it('given the personal data answer, the answered stop carries it, and no other stop does', () => {
    const stops = stopsOf(rows, marks, hrefOf, undefined, 'yes');
    expect(stops.map((s) => s.scopeAnswer)).toEqual([undefined, undefined, 'yes']);
    expect(stopsOf(rows, marks, hrefOf, undefined, null).every((s) => s.scopeAnswer === undefined)).toBe(true);
  });
});

describe('tallyOfRows', () => {
  it('9 done (2 without evidence) and 6 partly read "9 done (2 with no evidence attached), 6 partly"', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => row(`D${i}`, { kind: 'done', evidenceCount: i < 2 ? 0 : 1 })),
      ...Array.from({ length: 6 }, (_, i) => row(`P${i}`, { kind: 'shortfall' })),
    ];
    const marks = Object.fromEntries(rows.map((r) => [r.questionId, (r.kind === 'done' ? 'done' : 'partly') as StatusMarkKind]));
    const tally = tallyOfRows(rows, marks);
    expect(tallyWords(tally)).toBe('9 done (2 with no evidence attached), 6 partly');
    expect(Object.keys(tally).sort()).toEqual(['done', 'doneNoEvidence', 'partly']);
  });

  it('a gated done row counts by its mark, does not apply, and not as done with no evidence', () => {
    const rows = [row('A', { kind: 'not_applicable_by_gate' }), row('B', { kind: 'none' })];
    const tally = tallyOfRows(rows, { A: 'does_not_apply', B: 'no_decision' });
    expect(tally).toEqual({ does_not_apply: 1, no_decision: 1 });
  });
});
