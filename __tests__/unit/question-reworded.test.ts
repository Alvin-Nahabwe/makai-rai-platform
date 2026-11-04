import { describe, expect, it } from 'vitest';
import { isReworded, rewordedQuestionIds } from '@/lib/question/reworded';
import type { LoadedContent, LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';

/** FR-CNT-08: the reworded-practice marker compares only the expected practice of two content versions. */
const q = (id: string, expectedPractice: string, text = 'Same question'): LoadedQuestion => ({
  id, type: 'likert-5', text, principle: 'P', gaps: [], expectedPractice, whyAsked: 'w', reasonPrompt: 'r', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
});
const content = (semver: string, qs: LoadedQuestion[]) =>
  ({ semver, contentHash: semver, questions: new Map(qs.map((x) => [x.id, x])), areas: new Map(), controls: new Map(), reasonCodes: [] }) as unknown as LoadedContent;
const view = (questionId: string, semver: string, status: DecisionVersionView['status'] = 'done') =>
  ({ questionId, status, content: { contentVersionId: semver, semver, contentHash: semver } }) as DecisionVersionView;

describe('reworded marker', () => {
  it('FR-CNT-08: a question counts as reworded only when the expected practice differs', () => {
    expect(isReworded(q('Q-PP-01', 'Old wording.'), q('Q-PP-01', 'New wording.'))).toBe(true);
    expect(isReworded(q('Q-PP-01', 'Same.', 'Old text'), q('Q-PP-01', 'Same.', 'New text'))).toBe(false);
  });

  it('FR-CNT-08: rewordedQuestionIds lists the current decisions answered against an older wording, withdrawals excepted', () => {
    const older = content('0.0.1-fixture', [q('Q-PP-01', 'Old wording.'), q('Q-PP-02', 'Kept.'), q('Q-PP-03', 'Old three.')]);
    const running = content('0.0.2-fixture', [q('Q-PP-01', 'New wording.'), q('Q-PP-02', 'Kept.'), q('Q-PP-03', 'New three.')]);
    const current = new Map([
      ['Q-PP-01', view('Q-PP-01', '0.0.1-fixture')],
      ['Q-PP-02', view('Q-PP-02', '0.0.1-fixture')],
      ['Q-PP-03', view('Q-PP-03', '0.0.1-fixture', 'withdrawn')],
    ]);
    const load = (semver: string) => (semver === older.semver ? older : running);
    expect(rewordedQuestionIds(current, running, load)).toEqual(['Q-PP-01']);
    // a decision answered on the running version is never reworded
    expect(rewordedQuestionIds(new Map([['Q-PP-01', view('Q-PP-01', '0.0.2-fixture')]]), running, load)).toEqual([]);
  });
});
