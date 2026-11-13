import { describe, expect, it } from 'vitest';
import { STATUS_MARK_COPY, positionWords, tallyWords } from '@/lib/ui/copy';

/** Plan 1A Task 3, spec 7.2: the words of the marks, the tally and the position. */

describe('STATUS_MARK_COPY (spec 7.2)', () => {
  it('holds the spec\'s exact words', () => {
    expect(STATUS_MARK_COPY.done).toBe('Done');
    expect(STATUS_MARK_COPY.partly).toBe('Partly');
    expect(STATUS_MARK_COPY.not_yet).toBe('Not yet');
    expect(STATUS_MARK_COPY.not_applicable).toBe('Not applicable');
    expect(STATUS_MARK_COPY.does_not_apply).toBe('Does not apply (from your answer to the personal data question)');
    expect(STATUS_MARK_COPY.no_decision).toBe('No decision');
    expect(STATUS_MARK_COPY.noEvidence).toBe('no evidence attached');
    expect(['yes', 'no', 'not_sure'].map((a) => STATUS_MARK_COPY.scope_answered(a as 'yes' | 'no' | 'not_sure'))).toEqual(['Answer: Yes', 'Answer: No', 'Answer: Not sure']);
  });
});

describe('tallyWords', () => {
  it('tallyWords: plural rules, zero omitted, no total', () => {
    expect(tallyWords({ done: 9, partly: 6, not_yet: 2, no_decision: 1, doneNoEvidence: 2 })).toBe('9 done (2 with no evidence attached), 6 partly, 2 not yet, 1 no decision');
    expect(tallyWords({ done: 1 })).toBe('1 done');
    expect(tallyWords({})).toBe('No decisions recorded yet');
    expect(tallyWords({ done: 3, partly: 2 })).not.toMatch(/total|overall|%|of \d/i);
  });

  it('writes every kind in mark order, and a zero count is left out', () => {
    expect(tallyWords({ no_decision: 2, scope_answered: 1, does_not_apply: 3, not_applicable: 1, done: 0, doneNoEvidence: 0 }))
      .toBe('1 not applicable, 3 do not apply, 1 answered, 2 no decision');
  });
});

describe('positionWords', () => {
  it('positionWords', () => expect(positionWords(4, 22)).toBe('Question 4 of 22'));
});
