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

  it('calculates a score from quick assessment responses', () => {
    const responses = {};
    QUICK_QUESTIONS.forEach((qId) => { responses[qId] = 3; });
    const score = getQuickScore(responses);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
