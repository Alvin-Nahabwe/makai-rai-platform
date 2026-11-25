import { describe, expect, it } from 'vitest';
import { answerLabel, answerPrompt, practiceChanged } from '@/lib/question/answerWords';
import type { AnswerKey } from '@/types/content';

/** One lookup for a question's own words for a status, and for "the practice changed" (FR-CNT-08). */
const LABELS: Record<AnswerKey, string> = { done: 'Yes, we did', partly: 'Some of it', not_yet: 'Not so far', not_applicable: 'Does not apply' };
const PROMPTS: Record<AnswerKey, string> = { done: 'Say what you did.', partly: 'Say what is left.', not_yet: 'Say why not yet.', not_applicable: 'Say why it does not apply.' };

describe('answerLabel', () => {
  it('falls back to Done, Partly, Not yet and Not applicable when a question has no labels', () => {
    expect((['done', 'partly', 'not_yet', 'not_applicable'] as const).map((s) => answerLabel({}, s)))
      .toEqual(['Done', 'Partly', 'Not yet', 'Not applicable']);
  });
  it("returns the question's own label", () => {
    expect(answerLabel({ answerLabels: LABELS }, 'partly')).toBe('Some of it');
  });
});

describe('answerPrompt', () => {
  it("falls back to reasonPrompt, and to '' with no status", () => {
    expect(answerPrompt({ reasonPrompt: 'Why?' }, 'done')).toBe('Why?');
    expect(answerPrompt({ reasonPrompt: 'Why?' }, null)).toBe('Why?');
    expect(answerPrompt({}, 'done')).toBe('');
    expect(answerPrompt({ answerPrompts: PROMPTS }, null)).toBe('');
  });
  it("returns the question's own prompt for the status", () => {
    expect(answerPrompt({ answerPrompts: PROMPTS, reasonPrompt: 'Why?' }, 'not_yet')).toBe('Say why not yet.');
  });
});

describe('practiceChanged', () => {
  const then = { expectedPractice: 'Old.' };
  it('is false for a 5.1.0 answer when 5.2.0 lists 5.1.0', () => {
    expect(practiceChanged(then, '5.1.0', { expectedPractice: 'New.', practiceSameAs: ['5.1.0'] })).toBe(false);
  });
  it('is true for a 5.0.0 answer whose practice differs when 5.2.0 lists only 5.1.0', () => {
    expect(practiceChanged(then, '5.0.0', { expectedPractice: 'New.', practiceSameAs: ['5.1.0'] })).toBe(true);
  });
  it('is false when the texts are equal, listed or not', () => {
    expect(practiceChanged(then, '5.0.0', { expectedPractice: 'Old.' })).toBe(false);
  });
  it('is true when the earlier version does not hold the question', () => {
    expect(practiceChanged(undefined, '5.0.0', { expectedPractice: 'New.', practiceSameAs: ['5.0.0'] })).toBe(true);
  });
});
