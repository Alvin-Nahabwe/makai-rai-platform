import { describe, expect, it } from 'vitest';
import { FIELD_COPY } from '@/lib/ui/field/copy';
import { SORT_WORDS, STATUS_MARK_COPY, UI_COPY, positionWords, tallyWords } from '@/lib/ui/copy';

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

  it('owner, 13 Nov 2026: the personal data question is counted in a tally, as "1 answered"', () => {
    expect(tallyWords({ done: 2, scope_answered: 1 })).toBe('2 done, 1 answered');
  });

  it('owner, 13 Nov 2026: tally labels agree in number; "no decision" and "not yet" do not change', () => {
    expect(tallyWords({ does_not_apply: 1 })).toBe('1 does not apply');
    expect(tallyWords({ does_not_apply: 3 })).toBe('3 do not apply');
    expect(tallyWords({ no_decision: 1 })).toBe('1 no decision');
    expect(tallyWords({ no_decision: 4 })).toBe('4 no decision');
    expect(tallyWords({ not_yet: 1 })).toBe('1 not yet');
    expect(tallyWords({ not_yet: 5 })).toBe('5 not yet');
  });

  it('writes every kind in mark order, and a zero count is left out', () => {
    expect(tallyWords({ no_decision: 2, scope_answered: 1, does_not_apply: 3, not_applicable: 1, done: 0, doneNoEvidence: 0 }))
      .toBe('1 not applicable, 3 do not apply, 1 answered, 2 no decision');
  });
});

describe('UI_COPY.marks', () => {
  it('owner, 13 Nov 2026: the personal data question\'s mark reads "Answered" where no answer is at hand', () => {
    expect(UI_COPY.marks.answered).toBe('Answered');
  });
});

describe('positionWords', () => {
  it('positionWords', () => expect(positionWords(4, 22)).toBe('Question 4 of 22'));
});

describe('the structure components\' words (plan 1A Task 5)', () => {
  it('owner, 13 Nov 2026, "Words that fit the column": the sort line is "Sorted by {column}, {phrase}"', () => {
    expect(UI_COPY.table.sorted('Opened', SORT_WORDS.date.descending)).toBe('Sorted by Opened, latest first');
    expect(UI_COPY.table.sorted('Opened', SORT_WORDS.date.ascending)).toBe('Sorted by Opened, earliest first');
  });

  it('owner, 13 Nov 2026: the three common pairs, keyed by aria-sort\'s two values; never "ascending" or "in order"', () => {
    expect(SORT_WORDS).toEqual({
      date: { ascending: 'earliest first', descending: 'latest first' },
      name: { ascending: 'A to Z', descending: 'Z to A' },
      number: { ascending: 'lowest first', descending: 'highest first' },
    });
    for (const pair of Object.values(SORT_WORDS)) {
      for (const phrase of Object.values(pair)) expect(phrase).not.toMatch(/ascending|descending|in order|reverse/i);
    }
  });

  it('the breadcrumb\'s label, the plate\'s pin and the done step\'s hidden word', () => {
    expect(UI_COPY.breadcrumbLabel).toBe('Breadcrumb');
    expect(UI_COPY.plate.youAreHere).toBe('You are here');
    expect(UI_COPY.stepper.done).toBe('(done)');
  });
});

describe('the form fields\' words (NFR-PERF-02: a module of their own)', () => {
  it('FIELD_COPY holds the two words every form field shares', () => {
    expect(FIELD_COPY.required).toBe('(required)');
    expect(FIELD_COPY.errorPrefix).toBe('Error:');
  });

  it('UI_COPY.field is FIELD_COPY itself: one object, so the two cannot drift', () => {
    expect(UI_COPY.field).toBe(FIELD_COPY);
  });
});
