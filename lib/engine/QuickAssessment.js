// lib/engine/QuickAssessment.js

import questionBank from '../../data/questionBank.json';

/**
 * 10 highest-signal questions for Quick Assessment mode (<5 min).
 * Selected by: weight × cross-stage influence × principle coverage.
 */
export const QUICK_QUESTIONS = [
  'Q-PP-01', // AI appropriateness (weight: 0.20, Proportionality & Do Not Harm)
  'Q-PP-04', // Protected group impact (weight: 0.20, Fairness & Non-discrimination)
  'Q-PP-09', // Data representativeness (weight: 0.18, Fairness & Non-discrimination)
  'Q-PP-02', // Problem definition (weight: 0.15, Proportionality & Do Not Harm)
  'Q-PP-03', // Stakeholder identification (weight: 0.15, Multi-stakeholder Collaboration)
  'Q-PP-10', // Demographic distribution (weight: 0.15, Fairness & Non-discrimination)
  'Q-PP-05', // Human rights impact (weight: 0.15, Proportionality & Do Not Harm)
  'Q-PP-06', // Team diversity (weight: 0.10, Multi-stakeholder Collaboration)
  'Q-PP-08', // Data documentation (weight: 0.12, Transparency & Explainability)
  'Q-PP-11', // Proxy variable identification (weight: 0.12, Fairness & Non-discrimination)
];

/**
 * Check whether a question ID is part of the Quick Assessment set.
 * @param {string} questionId
 * @returns {boolean}
 */
export function isQuickQuestion(questionId) {
  return QUICK_QUESTIONS.includes(questionId);
}

/**
 * Retrieve full question objects for the Quick Assessment set from the question bank.
 * @returns {Array<object>}
 */
export function getQuickQuestions() {
  const questions = [];
  for (const stage of Object.values(questionBank.stages)) {
    for (const mod of stage.modules) {
      for (const q of mod.questions) {
        if (QUICK_QUESTIONS.includes(q.id)) questions.push(q);
      }
    }
  }
  return questions;
}

/**
 * Calculate a weighted score (0–100) from Quick Assessment responses.
 * Each response value is normalised to [0, 1] by dividing by 4 (max Likert value).
 * The score is the weighted average of normalised values, scaled to 100.
 *
 * @param {Record<string, number>} responses – map of questionId → numeric answer (0–4)
 * @returns {number} score in [0, 100]
 */
export function getQuickScore(responses) {
  const questions = getQuickQuestions();
  let totalWeight = 0;
  let weightedSum = 0;
  for (const q of questions) {
    const value = responses[q.id];
    if (value === undefined || value === null) continue;
    const weight = q.weight || 1;
    const normalized = typeof value === 'number' ? value / 4 : 0;
    weightedSum += normalized * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;
}
