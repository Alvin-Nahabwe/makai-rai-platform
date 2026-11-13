import { describe, expect, it } from 'vitest';
import { markKindOf, tallyOf } from '@/lib/ui/marks';

/** Plan 1A Task 3: which mark a question shows (spec 7.2's table), and the counts a tally is written from. */

describe('markKindOf', () => {
  it('markKindOf', () => {
    expect(markKindOf({ status: 'not_applicable', scopeAnswer: null, gated: true, isScopeQuestion: false })).toBe('does_not_apply');
    expect(markKindOf({ status: 'not_applicable', scopeAnswer: null, gated: false, isScopeQuestion: false })).toBe('not_applicable');
    expect(markKindOf({ status: null, scopeAnswer: null, gated: false, isScopeQuestion: true })).toBe('no_decision');
  });

  it('a question the personal data answer gates does not apply, whatever its own decision says', () => {
    // lib/question/stageList.ts makes a question "by gate" whenever the answer is No, with or without a decision of its own.
    expect(markKindOf({ status: null, scopeAnswer: null, gated: true, isScopeQuestion: false })).toBe('does_not_apply');
    expect(markKindOf({ status: 'done', scopeAnswer: null, gated: true, isScopeQuestion: false })).toBe('does_not_apply');
  });

  it('a saved status is its own mark, and no status is no decision', () => {
    for (const status of ['done', 'partly', 'not_yet'] as const) expect(markKindOf({ status, scopeAnswer: null, gated: false, isScopeQuestion: false })).toBe(status);
    expect(markKindOf({ status: null, scopeAnswer: null, gated: false, isScopeQuestion: false })).toBe('no_decision');
  });

  it('the personal data question shows the answer mark once it has an answer, and its status is never read', () => {
    // A decision on it carries scopeAnswer and never a status (lib/decision/rules.ts).
    for (const scopeAnswer of ['yes', 'no', 'not_sure'] as const) expect(markKindOf({ status: null, scopeAnswer, gated: false, isScopeQuestion: true })).toBe('scope_answered');
    expect(markKindOf({ status: 'done', scopeAnswer: null, gated: false, isScopeQuestion: true })).toBe('no_decision');
  });
});

describe('tallyOf', () => {
  it('counts each kind once per question and carries the done-with-no-evidence count', () => {
    expect(tallyOf(['done', 'done', 'partly', 'no_decision', 'done'], 2)).toEqual({ done: 3, partly: 1, no_decision: 1, doneNoEvidence: 2 });
  });

  it('leaves out kinds that do not occur and a zero no-evidence count', () => {
    expect(tallyOf([], 0)).toEqual({});
    expect(tallyOf(['not_yet'], 0)).toEqual({ not_yet: 1 });
  });
});
