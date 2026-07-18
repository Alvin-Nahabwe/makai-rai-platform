// __tests__/quick-assessment.test.js
import { describe, it, expect } from 'vitest';
import { QUICK_QUESTIONS, isQuickQuestion, getQuickScore } from '../lib/engine/QuickAssessment.js';

describe('Quick Assessment', () => {
  it('selects exactly 10 high-signal questions', () => {
    expect(QUICK_QUESTIONS).toHaveLength(10);
  });

  it('isQuickQuestion identifies members of the quick set', () => {
    expect(isQuickQuestion(QUICK_QUESTIONS[0])).toBe(true);
    expect(isQuickQuestion('Q-DOES-NOT-EXIST')).toBe(false);
  });

  it('all selected questions exist in the question bank', () => {
    const questionBank = require('../data/questionBank.json');
    const allIds = [];
    for (const stage of Object.values(questionBank.stages)) {
      for (const mod of stage.modules) {
        for (const q of mod.questions) { allIds.push(q.id); }
      }
    }
    QUICK_QUESTIONS.forEach((qId) => { expect(allIds).toContain(qId); });
  });

  it('scores a uniform "3" response as exactly 75 (3/4 normalized, weight-independent)', () => {
    const responses = {};
    QUICK_QUESTIONS.forEach((qId) => { responses[qId] = 3; });
    expect(getQuickScore(responses)).toBe(75);
  });

  it('scores all-zero as 0 and all-max as 100', () => {
    const zero = {};
    const max = {};
    QUICK_QUESTIONS.forEach((qId) => { zero[qId] = 0; max[qId] = 4; });
    expect(getQuickScore(zero)).toBe(0);
    expect(getQuickScore(max)).toBe(100);
  });

  it('ignores unanswered questions when scoring', () => {
    // Only one question answered — score reflects just that answer.
    const responses = { [QUICK_QUESTIONS[0]]: 4 };
    expect(getQuickScore(responses)).toBe(100);
  });
});
