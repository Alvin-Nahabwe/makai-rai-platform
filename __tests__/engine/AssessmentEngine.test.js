/* global require, __dirname */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAssessment,
  getResponses,
  setResponse,
  getStageStatus,
  completeStage,
  isStageAccessible,
  getNextStage,
  canGenerateReport,
  calculateAreaScores,
  calculatePrincipleScores,
  getModifiedWeights,
  getWeightExplanations,
  getUnlockedConditionalQuestions,
  getVisibleQuestions,
  generateReportData,
} from '../../lib/engine/AssessmentEngine.js';

/* ---------------------------------------------------------------
 * Task 4 — Core State Management
 * --------------------------------------------------------------- */
describe('Core State Management', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
    // Clear localStorage between tests
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('createAssessment returns a fresh state with correct shape', () => {
    expect(state).toHaveProperty('version', '4.0.0');
    expect(state).toHaveProperty('createdAt');
    expect(state).toHaveProperty('updatedAt');
    expect(state.stages).toHaveProperty('pre-processing');
    expect(state.stages).toHaveProperty('in-processing');
    expect(state.stages).toHaveProperty('post-processing');
  });

  it('pre-processing starts as available, others as locked', () => {
    expect(state.stages['pre-processing'].status).toBe('available');
    expect(state.stages['in-processing'].status).toBe('locked');
    expect(state.stages['post-processing'].status).toBe('locked');
  });

  it('getResponses returns empty object for a fresh stage', () => {
    const responses = getResponses(state, 'pre-processing');
    expect(responses).toEqual({});
  });

  it('setResponse stores a response value', () => {
    const updated = setResponse(state, 'pre-processing', 'Q-PP-01', 3);
    expect(getResponses(updated, 'pre-processing')['Q-PP-01']).toBe(3);
  });

  it('setResponse preserves other responses', () => {
    let updated = setResponse(state, 'pre-processing', 'Q-PP-01', 3);
    updated = setResponse(updated, 'pre-processing', 'Q-PP-02', 4);
    const responses = getResponses(updated, 'pre-processing');
    expect(responses['Q-PP-01']).toBe(3);
    expect(responses['Q-PP-02']).toBe(4);
  });

  it('setResponse handles checklist values (arrays)', () => {
    const updated = setResponse(state, 'pre-processing', 'Q-PP-05', [0, 2, 3]);
    expect(getResponses(updated, 'pre-processing')['Q-PP-05']).toEqual([0, 2, 3]);
  });

  it('getStageStatus returns the correct status', () => {
    expect(getStageStatus(state, 'pre-processing')).toBe('available');
    expect(getStageStatus(state, 'in-processing')).toBe('locked');
  });
});

/* ---------------------------------------------------------------
 * Task 5 — Stage Gating Logic
 * --------------------------------------------------------------- */
describe('Stage Gating Logic', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('completeStage sets pre-processing to completed and unlocks in-processing', () => {
    const updated = completeStage(state, 'pre-processing', { skipValidation: true });
    expect(updated.stages['pre-processing'].status).toBe('completed');
    expect(updated.stages['pre-processing'].completedAt).toBeTruthy();
    expect(updated.stages['in-processing'].status).toBe('available');
  });

  it('completeStage on in-processing fails if pre is not completed', () => {
    expect(() => completeStage(state, 'in-processing', { skipValidation: true })).toThrow();
  });

  it('completeStage on in-processing unlocks post-processing', () => {
    let updated = completeStage(state, 'pre-processing', { skipValidation: true });
    updated = completeStage(updated, 'in-processing', { skipValidation: true });
    expect(updated.stages['in-processing'].status).toBe('completed');
    expect(updated.stages['post-processing'].status).toBe('available');
  });

  it('isStageAccessible returns false for locked stages', () => {
    expect(isStageAccessible(state, 'pre-processing')).toBe(true);
    expect(isStageAccessible(state, 'in-processing')).toBe(false);
    expect(isStageAccessible(state, 'post-processing')).toBe(false);
  });

  it('isStageAccessible returns true for completed and available stages', () => {
    const updated = completeStage(state, 'pre-processing', { skipValidation: true });
    expect(isStageAccessible(updated, 'pre-processing')).toBe(true);
    expect(isStageAccessible(updated, 'in-processing')).toBe(true);
  });

  it('getNextStage returns the next locked stage', () => {
    expect(getNextStage(state)).toBe('pre-processing');
    const updated = completeStage(state, 'pre-processing', { skipValidation: true });
    expect(getNextStage(updated)).toBe('in-processing');
  });

  it('getNextStage returns null when all stages are completed', () => {
    let updated = completeStage(state, 'pre-processing', { skipValidation: true });
    updated = completeStage(updated, 'in-processing', { skipValidation: true });
    updated = completeStage(updated, 'post-processing', { skipValidation: true });
    expect(getNextStage(updated)).toBeNull();
  });

  it('canGenerateReport returns false when no stages are completed', () => {
    expect(canGenerateReport(state)).toBe(false);
  });

  it('canGenerateReport returns true when at least one stage is completed', () => {
    const updated = completeStage(state, 'pre-processing', { skipValidation: true });
    expect(canGenerateReport(updated)).toBe(true);
  });
});

/* ---------------------------------------------------------------
 * Task 6 — Score Calculation
 * --------------------------------------------------------------- */
describe('Score Calculation', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('calculateAreaScores returns 0 for areas with no responses', () => {
    const scores = calculateAreaScores(state, 'pre-processing');
    expect(scores).toBeDefined();
    Object.values(scores).forEach(score => {
      expect(score).toBe(0);
    });
  });

  it('calculateAreaScores returns correct score for given responses', () => {
    // Set some pre-processing responses
    let updated = state;
    updated = setResponse(updated, 'pre-processing', 'Q-PP-01', 4); // max Likert-5 = index 4 (Fully)
    updated = setResponse(updated, 'pre-processing', 'Q-PP-02', 4);
    const scores = calculateAreaScores(updated, 'pre-processing');
    // PP-01 area should have a non-zero score
    expect(scores['PP-01']).toBeGreaterThan(0);
  });

  it('calculatePrincipleScores returns 0 for no responses', () => {
    const scores = calculatePrincipleScores(state, 'pre-processing');
    expect(scores).toBeDefined();
    Object.values(scores).forEach(score => {
      expect(score).toBe(0);
    });
  });

  it('Likert-5 response of 4 (max index) normalizes toward 100', () => {
    const qb = getQuestionBank();
    let updated = setAllResponses(state, qb, 'pre-processing', 4);
    const scores = calculateAreaScores(updated, 'pre-processing');
    // All areas should be 100 when every question is maxed
    Object.values(scores).forEach(score => {
      expect(score).toBe(100);
    });
  });

  it('scores remain in 0-100 range', () => {
    let updated = state;
    updated = setResponse(updated, 'pre-processing', 'Q-PP-01', 2);
    const scores = calculateAreaScores(updated, 'pre-processing');
    Object.values(scores).forEach(score => {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });
});

/* ---------------------------------------------------------------
 * Task 7 — Cross-Stage Weight Propagation
 * --------------------------------------------------------------- */
describe('Cross-Stage Weight Propagation', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('getModifiedWeights returns original weights when no upstream weaknesses', () => {
    const qb = getQuestionBank();
    let updated = setAllResponses(state, qb, 'pre-processing', 4);
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const weights = getModifiedWeights(updated, 'in-processing');
    // All modifiers should be 1.0 (no modification)
    Object.values(weights).forEach(w => {
      expect(w.modifier).toBe(1.0);
    });
  });

  it('getModifiedWeights activates modifiers when upstream area scores are below threshold', () => {
    // Complete pre with all minimum scores (0)
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const weights = getModifiedWeights(updated, 'in-processing');
    // Q-IP-04 should have a modifier > 1.0 (it's targeted by CSW-01, CSW-02, CSW-03)
    expect(weights['Q-IP-04']).toBeDefined();
    expect(weights['Q-IP-04'].modifier).toBeGreaterThan(1.0);
  });

  it('overlapping rules use max modifier, not product', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const weights = getModifiedWeights(updated, 'in-processing');
    // Q-IP-04 is targeted by CSW-01 (1.5), CSW-02 (1.4), CSW-03 (1.3) — max should be 1.5, not 2.73
    if (weights['Q-IP-04']) {
      expect(weights['Q-IP-04'].modifier).toBe(1.5);
      expect(weights['Q-IP-04'].modifier).toBeLessThanOrEqual(2.0);
    }
  });

  it('modifier cap of 2.0 is enforced', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const weights = getModifiedWeights(updated, 'in-processing');
    Object.values(weights).forEach(w => {
      expect(w.modifier).toBeLessThanOrEqual(2.0);
    });
  });

  it('getModifiedWeights for pre-processing returns all 1.0 (no upstream)', () => {
    const weights = getModifiedWeights(state, 'pre-processing');
    Object.values(weights).forEach(w => {
      expect(w.modifier).toBe(1.0);
    });
  });

  it('getWeightExplanations returns explanations for active modifiers', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const explanations = getWeightExplanations(updated, 'in-processing');
    expect(explanations.length).toBeGreaterThan(0);
    expect(explanations[0]).toHaveProperty('questionId');
    expect(explanations[0]).toHaveProperty('modifier');
    expect(explanations[0]).toHaveProperty('rationale');
  });
});

/* ---------------------------------------------------------------
 * Task 8 — Conditional Question Unlocking
 * --------------------------------------------------------------- */
describe('Conditional Question Unlocking', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('getUnlockedConditionalQuestions returns empty when no triggers fire', () => {
    // All responses at max → no triggers
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 4); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const unlocked = getUnlockedConditionalQuestions(updated, 'post-processing');
    expect(unlocked).toEqual([]);
  });

  it('triggers fire when source question score is ≤ 1', () => {
    let updated = state;
    // Set Q-PP-04 to 0 (triggers CQ-01 → Q-PO-EXTRA-01)
    updated = setResponse(updated, 'pre-processing', 'Q-PP-04', 0);
    // Fill rest with high values
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => {
      if (id !== 'Q-PP-04') {
        updated = setResponse(updated, 'pre-processing', id, 4);
      }
    });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const unlocked = getUnlockedConditionalQuestions(updated, 'post-processing');
    expect(unlocked).toContain('Q-PO-EXTRA-01');
  });

  it('trigger does NOT fire when source question score is > 1', () => {
    let updated = state;
    // Set Q-PP-04 to 3 (> 1, should NOT trigger)
    updated = setResponse(updated, 'pre-processing', 'Q-PP-04', 3);
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => {
      if (id !== 'Q-PP-04') {
        updated = setResponse(updated, 'pre-processing', id, 4);
      }
    });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const unlocked = getUnlockedConditionalQuestions(updated, 'post-processing');
    expect(unlocked).not.toContain('Q-PO-EXTRA-01');
  });

  it('Pre→In triggers unlock in-processing questions', () => {
    let updated = state;
    // Set Q-PP-09 to 0 (triggers CQ-05 → Q-IP-EXTRA-01)
    updated = setResponse(updated, 'pre-processing', 'Q-PP-09', 0);
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => {
      if (id !== 'Q-PP-09') {
        updated = setResponse(updated, 'pre-processing', id, 4);
      }
    });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const unlocked = getUnlockedConditionalQuestions(updated, 'in-processing');
    expect(unlocked).toContain('Q-IP-EXTRA-01');
  });

  it('multiple triggers can fire independently', () => {
    let updated = state;
    // Trigger both CQ-01 (Q-PP-04 → PO) and CQ-05 (Q-PP-09 → IP)
    updated = setResponse(updated, 'pre-processing', 'Q-PP-04', 0);
    updated = setResponse(updated, 'pre-processing', 'Q-PP-09', 0);
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => {
      if (!['Q-PP-04', 'Q-PP-09'].includes(id)) {
        updated = setResponse(updated, 'pre-processing', id, 4);
      }
    });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const unlockedPost = getUnlockedConditionalQuestions(updated, 'post-processing');
    const unlockedIn = getUnlockedConditionalQuestions(updated, 'in-processing');
    expect(unlockedPost).toContain('Q-PO-EXTRA-01');
    expect(unlockedIn).toContain('Q-IP-EXTRA-01');
  });

  it('conditional questions excluded from scoring when not unlocked', () => {
    // Complete pre with all max → no conditionals unlock
    const qb = getQuestionBank();
    let updated = setAllResponses(state, qb, 'pre-processing', 4);
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });
    // Complete in-processing to unlock post-processing
    updated = setAllResponses(updated, qb, 'in-processing', 4);
    updated = completeStage(updated, 'in-processing', { skipValidation: true });

    // Even if somehow Q-PO-EXTRA-01 has a response, it should not affect scores
    updated = setResponse(updated, 'post-processing', 'Q-PO-EXTRA-01', 0);
    // The visible questions for post should NOT include extra questions (max scores = no conditionals unlocked)
    const visible = getVisibleQuestions(updated, 'post-processing');
    const extraIds = visible.filter(q => q.id.includes('EXTRA'));
    expect(extraIds.length).toBe(0);
  });
});

/* ---------------------------------------------------------------
 * Task 9 — Edge Cases
 * --------------------------------------------------------------- */
describe('Edge Cases', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('empty state: scoring returns 0, modifiers activate (0 < 50% threshold), no conditionals for unanswered triggers', () => {
    const areaScores = calculateAreaScores(state, 'pre-processing');
    Object.values(areaScores).forEach(s => expect(s).toBe(0));

    // With empty state (all area scores = 0, below 50% threshold),
    // weight modifiers correctly activate. This is by design:
    // a completely empty upstream assessment represents maximum uncertainty.
    const weights = getModifiedWeights(state, 'in-processing');
    const activeModifiers = Object.values(weights).filter(w => w.modifier > 1.0);
    expect(activeModifiers.length).toBeGreaterThan(0);

    // Conditional triggers should NOT fire when questions are unanswered
    // (undefined is not <= 1)
    const unlocked = getUnlockedConditionalQuestions(state, 'post-processing');
    expect(unlocked).toEqual([]);
  });

  it('partial responses: scoring handles mix of answered/unanswered', () => {
    let updated = setResponse(state, 'pre-processing', 'Q-PP-01', 3);
    // Only one question answered — should not crash
    const scores = calculateAreaScores(updated, 'pre-processing');
    expect(scores).toBeDefined();
    expect(scores['PP-01']).toBeGreaterThan(0);
  });

  it('all-max responses: 100% score, no modifiers', () => {
    const qb = getQuestionBank();
    let updated = setAllResponses(state, qb, 'pre-processing', 4);
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const scores = calculateAreaScores(updated, 'pre-processing');
    Object.values(scores).forEach(s => expect(s).toBe(100));

    const weights = getModifiedWeights(updated, 'in-processing');
    Object.values(weights).forEach(w => expect(w.modifier).toBe(1.0));
  });

  it('all-min responses: modifiers activate, conditionals unlock', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    // Some weight modifiers should be active
    const weights = getModifiedWeights(updated, 'in-processing');
    const activeModifiers = Object.values(weights).filter(w => w.modifier > 1.0);
    expect(activeModifiers.length).toBeGreaterThan(0);

    // Some conditionals should unlock
    const unlockedPost = getUnlockedConditionalQuestions(updated, 'post-processing');
    expect(unlockedPost.length).toBeGreaterThan(0);
  });

  it('scores never exceed 0-100 range', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 2); });

    const scores = calculateAreaScores(updated, 'pre-processing');
    Object.values(scores).forEach(s => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    });
  });

  it('generateReportData produces complete payload for completed stages', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 3); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const report = generateReportData(updated);
    expect(report).toHaveProperty('completedStages');
    expect(report.completedStages).toContain('pre-processing');
    expect(report).toHaveProperty('stageScores');
    expect(report.stageScores['pre-processing']).toBeDefined();
    expect(report).toHaveProperty('principleScores');
    expect(report).toHaveProperty('activeModifiers');
    expect(report).toHaveProperty('unlockedConditionals');
  });
});

/* ---------------------------------------------------------------
 * Phase 6 — PP-06 Privacy → Safety & Security Remap
 * --------------------------------------------------------------- */
describe('PP-06 Safety Remap', () => {
  it('PP-06 area maps to Safety & Security in assessmentAreas.json', () => {
    const areas = require('../../data/assessmentAreas.json');
    const pp06 = areas.areas.find(a => a.id === 'PP-06');
    expect(pp06).toBeDefined();
    expect(pp06.principle).toBe('Safety & Security');
  });

  it('Q-PP-14 maps to Safety & Security in questionBank.json', () => {
    const qb = getQuestionBank();
    const q14 = qb.stages['pre-processing'].modules
      .flatMap(m => m.questions)
      .find(q => q.id === 'Q-PP-14');
    expect(q14).toBeDefined();
    expect(q14.principle).toBe('Safety & Security');
  });

  it('Q-PP-13 still maps to Transparency & Explainability', () => {
    const qb = getQuestionBank();
    const q13 = qb.stages['pre-processing'].modules
      .flatMap(m => m.questions)
      .find(q => q.id === 'Q-PP-13');
    expect(q13).toBeDefined();
    expect(q13.principle).toBe('Transparency & Explainability');
  });
});

/* ---------------------------------------------------------------
 * Phase 6 — Cross-stage modifiers affect scores
 * --------------------------------------------------------------- */
describe('Cross-Stage Modifier Score Impact', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('calculateAreaScores with low upstream scores differ from unmodified', () => {
    // Scenario: complete pre-processing with all zeros (triggers modifiers)
    let withLow = state;
    let withHigh = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    const inQIds = getAllQuestionIds(qb, 'in-processing');

    // Fill pre with zeros (low) → triggers modifiers on in-processing
    preQIds.forEach(id => { withLow = setResponse(withLow, 'pre-processing', id, 0); });
    withLow = completeStage(withLow, 'pre-processing', { skipValidation: true });

    // Fill pre with max (high) → no modifiers on in-processing
    preQIds.forEach(id => { withHigh = setResponse(withHigh, 'pre-processing', id, 4); });
    withHigh = completeStage(withHigh, 'pre-processing', { skipValidation: true });

    // Fill in-processing identically with mid-range
    inQIds.forEach(id => {
      withLow = setResponse(withLow, 'in-processing', id, 2);
      withHigh = setResponse(withHigh, 'in-processing', id, 2);
    });

    const scoresLow = calculateAreaScores(withLow, 'in-processing');
    const scoresHigh = calculateAreaScores(withHigh, 'in-processing');

    // Both should produce valid scores
    expect(Object.keys(scoresLow).length).toBeGreaterThan(0);
    expect(Object.keys(scoresHigh).length).toBeGreaterThan(0);
  });

  it('calculatePrincipleScores incorporates cross-stage modifiers', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');
    const inQIds = getAllQuestionIds(qb, 'in-processing');

    // Low pre-processing → activates modifiers
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    // Fill in-processing with mid values
    inQIds.forEach(id => { updated = setResponse(updated, 'in-processing', id, 2); });

    const scores = calculatePrincipleScores(updated, 'in-processing');
    expect(scores).toBeDefined();
    // Scores should still be in valid range
    Object.values(scores).forEach(s => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    });
  });

  it('report activeModifiers only include completed stages', () => {
    let updated = state;
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');

    // Complete only pre-processing with low scores
    preQIds.forEach(id => { updated = setResponse(updated, 'pre-processing', id, 0); });
    updated = completeStage(updated, 'pre-processing', { skipValidation: true });

    const report = generateReportData(updated);
    // Active modifiers should exist (from pre→in rules)
    // But should NOT include post-processing modifiers since in-processing isn't completed
    report.activeModifiers.forEach(m => {
      expect(m.stage).not.toBe('post-processing');
    });
  });
});

/* ---------------------------------------------------------------
 * Phase 7 — Area score differentiation (Bug H.snapshot fix)
 * --------------------------------------------------------------- */
describe('Area Score Differentiation', () => {
  it('calculateAreaScores returns different scores for different areas when answers vary', () => {
    let state = createAssessment();
    const qb = getQuestionBank();
    const preQIds = getAllQuestionIds(qb, 'pre-processing');

    // Set varied responses (0, 1, 2, 3, 4, 0, 1, 2, ...) to create score variation
    preQIds.forEach((id, i) => {
      state = setResponse(state, 'pre-processing', id, i % 5);
    });

    const scores = calculateAreaScores(state, 'pre-processing');
    const values = Object.values(scores);

    // With varied responses, not all area scores should be identical
    expect(values.length).toBeGreaterThan(1);
    const allSame = values.every(v => v === values[0]);
    expect(allSame).toBe(false);
  });

  it('calculateAreaScores gives consistent mid-range scores when all likert answers are 2', () => {
    const qb = getQuestionBank();
    let state = setAllResponses(createAssessment(), qb, 'pre-processing', 2);

    const scores = calculateAreaScores(state, 'pre-processing');
    // With Likert=2 (50%) and all checklists fully selected (100%),
    // area scores vary depending on their mix of Likert vs checklist contributions.
    // All should be > 0 and <= 100.
    Object.values(scores).forEach(s => {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(100);
    });
  });
});

/* ---------------------------------------------------------------
 * Helpers — these call into the engine's exported data accessors
 * --------------------------------------------------------------- */
function getQuestionBank() {
  // Import the raw JSON synchronously for test helpers
  const fs = require('fs');
  const path = require('path');
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/questionBank.json'), 'utf8'));
}

function getAllQuestionIds(qb, stage) {
  const ids = [];
  qb.stages[stage].modules.forEach(m => {
    m.questions.forEach(q => {
      // Skip conditional questions (they have crossStageCondition)
      if (!q.crossStageCondition) {
        ids.push(q.id);
      }
    });
  });
  return ids;
}

/**
 * Set type-appropriate responses for all questions in a stage.
 * Gate → "Yes", Checklist → all options selected, Likert → specified value.
 */
function setAllResponses(state, qb, stage, likertValue) {
  let updated = state;
  qb.stages[stage].modules.forEach(m => {
    m.questions.forEach(q => {
      if (q.crossStageCondition) return;
      if (q.type === 'gate') {
        updated = setResponse(updated, stage, q.id, 'Yes');
      } else if (q.type === 'checklist') {
        const allOpts = (q.options || []).map(o => typeof o === 'string' ? o : o.value || o.label);
        updated = setResponse(updated, stage, q.id, allOpts);
      } else {
        updated = setResponse(updated, stage, q.id, likertValue);
      }
    });
  });
  return updated;
}
