import { describe, expect, it } from 'vitest';
import { foldRoute, lineTallyWords, nextApplyingId, ROUTE_FOLD, tallyOfRows, tallyParts } from '@/lib/question/route';
import { tallyWords } from '@/lib/ui/copy';
import type { StatusMarkKind } from '@/components/ui/types';
import type { StageRow } from '@/lib/question/stageList';

/** Plan 1C Task 2: a stage as a row of marks (spec 7.2): its stops and its tally, from the stage's rows and marks. */
const row = (questionId: string, over: Partial<StageRow> = {}): StageRow => ({
  questionId, questionType: 'likert-5', text: `${questionId} text`, moduleId: 'M1', moduleTitle: 'Problem Formulation', statusText: 'No decision',
  versionNumber: null, declaredDate: null, openFindings: 0, changedSinceSeal: false, reworded: false, inPlace: null, kind: 'none', evidenceCount: 0, ...over,
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

/**
 * Lane 1 Task 2 (owner's answer R1, 15 November 2026): the question page's column is one line of the stage's questions in
 * stage order, with the questions away from the open one folded into one row per run. foldRoute decides the folding.
 */
describe('foldRoute', () => {
  const stage = (n: number) => Array.from({ length: n }, (_, i) => row(`Q-${String(i + 1).padStart(2, '0')}`));
  const id = (i: number) => `Q-${String(i).padStart(2, '0')}`;
  /** Each part as a short string: a row as its number, a run as "first-last". */
  const shape = (parts: ReturnType<typeof foldRoute<StageRow>>) =>
    parts.map((p) => (p.kind === 'row' ? String(p.number) : `${p.first}-${p.last}`));
  const numbersIn = (parts: ReturnType<typeof foldRoute<StageRow>>) =>
    parts.flatMap((p) => (p.kind === 'row' ? [p.number] : p.rows.map((r) => r.number)));

  it('a stage of 8 questions or fewer folds nothing', () => {
    expect(shape(foldRoute(stage(8), { currentId: id(4), nextId: id(5), fold: true }))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(ROUTE_FOLD.shortStage).toBe(8);
  });

  it('in the middle: the run before folds, one question before the open one shows, then the open one and the next ones, then the run after folds', () => {
    expect(shape(foldRoute(stage(22), { currentId: id(4), nextId: id(5), fold: true }))).toEqual(['1-2', '3', '4', '5', '6', '7-22']);
  });

  it('on the first question nothing is folded before it, and the window runs forward from it', () => {
    expect(shape(foldRoute(stage(22), { currentId: id(1), nextId: id(2), fold: true }))).toEqual(['1', '2', '3', '4', '5-22']);
  });

  it('on the last question the window runs back from it, so the column shows as many questions as anywhere else', () => {
    expect(shape(foldRoute(stage(22), { currentId: id(22), nextId: null, fold: true }))).toEqual(['1-18', '19', '20', '21', '22']);
  });

  it('a run of one question is not folded: it shows as its own row', () => {
    expect(shape(foldRoute(stage(22), { currentId: id(3), nextId: id(4), fold: true }))).toEqual(['1', '2', '3', '4', '5', '6-22']);
    expect(shape(foldRoute(stage(9), { currentId: id(6), nextId: id(7), fold: true }))).toEqual(['1-4', '5', '6', '7', '8', '9']);
    expect(shape(foldRoute(stage(9), { currentId: id(4), nextId: id(5), fold: true }))).toEqual(['1-2', '3', '4', '5', '6', '7-9']);
  });

  it('the next question is never folded, also when the questions between are switched off by the personal data answer', () => {
    // Q-05 to Q-09 do not apply, so the next question is Q-10: the window reaches it, and the switched-off ones show on the way.
    const parts = foldRoute(stage(22), { currentId: id(4), nextId: id(10), fold: true });
    expect(shape(parts)).toEqual(['1-2', '3', '4', '5', '6', '7', '8', '9', '10', '11-22']);
  });

  it('every question of the stage is in exactly one part, in stage order, wherever the open question is', () => {
    for (const at of [1, 2, 5, 11, 21, 22]) {
      expect(numbersIn(foldRoute(stage(22), { currentId: id(at), nextId: at < 22 ? id(at + 1) : null, fold: true }))).toEqual(
        Array.from({ length: 22 }, (_, i) => i + 1),
      );
    }
  });

  it('with folding off (a filter active, or the stage page), or with no open question, nothing is folded', () => {
    expect(foldRoute(stage(22), { currentId: id(4), nextId: id(5), fold: false }).every((p) => p.kind === 'row')).toBe(true);
    expect(foldRoute(stage(22), { fold: true }).every((p) => p.kind === 'row')).toBe(true);
    expect(foldRoute(stage(22), { currentId: 'Q-NOT-HERE', fold: true }).every((p) => p.kind === 'row')).toBe(true);
  });

  it('a run lists its rows with their numbers in the stage', () => {
    const parts = foldRoute(stage(22), { currentId: id(4), nextId: id(5), fold: true });
    const first = parts[0];
    expect(first.kind === 'run' && first.rows.map((r) => [r.number, r.row.questionId])).toEqual([[1, 'Q-01'], [2, 'Q-02']]);
  });
});

describe('nextApplyingId', () => {
  it('is the next question after the open one that applies, as the page\'s Next: a question the personal data answer switches off is passed over', () => {
    const rows = [row('A'), row('B', { kind: 'not_applicable_by_gate' }), row('C'), row('D')];
    expect(nextApplyingId(rows, 'A')).toBe('C');
    expect(nextApplyingId(rows, 'B')).toBe('C');
    expect(nextApplyingId(rows, 'D')).toBeNull();
    expect(nextApplyingId(rows, 'Z')).toBeNull();
  });
});

describe('lineTallyWords (a folded run\'s tally)', () => {
  it('one line with middots, no parenthetical: the row keeps "no evidence attached"; the personal data question by its term', () => {
    const tally = { done: 2, doneNoEvidence: 2, not_yet: 1, scope_answered: 1, no_decision: 14 };
    expect(lineTallyWords(tally)).toBe('2 done · 1 not yet · 1 personal data question answered · 14 no decision');
    expect(lineTallyWords(tally)).not.toMatch(/\(|\bscope\b/);
  });
});

describe('tallyParts', () => {
  it('one part per kind that occurs, in the tally\'s order, each in the tally\'s own words', () => {
    const tally = { no_decision: 3, done: 4, doneNoEvidence: 1, partly: 2 };
    expect(tallyParts(tally)).toEqual([
      { kind: 'done', words: '4 done (1 with no evidence attached)' },
      { kind: 'partly', words: '2 partly' },
      { kind: 'no_decision', words: '3 no decision' },
    ]);
    expect(tallyParts(tally).map((p) => p.words).join(', ')).toBe(tallyWords(tally));
  });

  it('the personal data question\'s part names it by the vocabulary\'s term, never "scope" or a bare "answered"', () => {
    expect(tallyParts({ scope_answered: 1 })).toEqual([{ kind: 'scope_answered', words: '1 personal data question answered' }]);
  });

  it('every kind of mark has a part: with all seven present, the parts\' counts add up to the rows (silent-failure review F4)', () => {
    const tally = { done: 1, partly: 2, not_yet: 3, not_applicable: 4, does_not_apply: 5, scope_answered: 1, no_decision: 7 };
    const parts = tallyParts(tally);
    expect(parts.map((p) => p.kind)).toEqual(['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision']);
    expect(parts.reduce((n, p) => n + Number(p.words.split(' ')[0]), 0)).toBe(23);
  });
});
