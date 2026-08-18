import { describe, it, expect } from 'vitest';
import {
  createAssessment,
  setResponse,
  calculatePrincipleScores,
} from '../../lib/engine/AssessmentEngine.js';
import questionBank from '../../data/questionBank.json' with { type: 'json' };

/**
 * Scoring-weight correctness.
 *
 * These tests are written against the question bank as it actually ships, not
 * against fixtures, because both defects they cover were invisible to fixture
 * tests: the numbers only go wrong when real declared weights meet real
 * question types.
 */

/** Every question in the shipped bank, regardless of how deeply it is nested. */
function allQuestions() {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.id && node.type) out.push(node);
      Object.values(node).forEach(walk);
    }
  })(questionBank.stages);
  return out;
}

/** Answer every scoring question in a stage at its maximum value. */
function answerStagePerfectly(state, stage) {
  let s = state;
  for (const q of allQuestions().filter((q) => q.stage === stage || q.id.startsWith(stagePrefix(stage)))) {
    if (q.type === 'likert-5') s = setResponse(s, stage, q.id, 4);
    else if (q.type === 'checklist') s = setResponse(s, stage, q.id, (q.options ?? []).map((o) => o.value ?? o));
    else if (q.type === 'gate') s = setResponse(s, stage, q.id, 'yes');
  }
  return s;
}

function stagePrefix(stage) {
  return { 'pre-processing': 'Q-PP', 'in-processing': 'Q-IP', 'post-processing': 'Q-PO' }[stage] ?? 'Q-';
}

describe('a gate question must not dilute the principle it belongs to', () => {
  /**
   * Q-PP-GATE-SENSITIVE declares `weight: 0` and is typed `gate`;
   * normalizeResponse returns 0 for gates because "gate questions don't
   * contribute to scores". A gate must therefore be absent from BOTH sides of
   * the weighted average — contributing 0 to the numerator while adding to the
   * denominator is what caps the principle below 100.
   */
  it('scores Transparency & Explainability at 100 when every pre-processing answer is maximal', () => {
    const perfect = answerStagePerfectly(createAssessment(), 'pre-processing');
    const scores = calculatePrincipleScores(perfect, 'pre-processing');

    expect(scores['Transparency & Explainability']).toBe(100);
  });

  it('scores every other pre-processing principle at 100 too, so the gate is the only variable', () => {
    const perfect = answerStagePerfectly(createAssessment(), 'pre-processing');
    const scores = calculatePrincipleScores(perfect, 'pre-processing');

    for (const [principle, score] of Object.entries(scores)) {
      expect(score, `principle "${principle}" should reach 100 on perfect answers`).toBe(100);
    }
  });

  it('leaves the gate answer itself unable to move the score in either direction', () => {
    const base = answerStagePerfectly(createAssessment(), 'pre-processing');
    const gate = allQuestions().find((q) => q.type === 'gate');
    expect(gate, 'the bank should still contain a gate question').toBeTruthy();

    const answeredYes = setResponse(base, 'pre-processing', gate.id, 'yes');
    const answeredNo = setResponse(base, 'pre-processing', gate.id, 'no');

    const yes = calculatePrincipleScores(answeredYes, 'pre-processing')[gate.principle];
    const no = calculatePrincipleScores(answeredNo, 'pre-processing')[gate.principle];

    expect(yes).toBe(no);
  });
});
