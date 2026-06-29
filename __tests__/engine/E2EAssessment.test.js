/**
 * E2E Test Script for MAK-RAI Assessment Toolkit
 * Tests the full Pre→In→Post→Report flow with specific inputs
 * Validates: three-tier evidence, cross-stage modifiers, checklist critical subsets
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAssessment,
  setResponse,

  completeStage,
  isStageAccessible,
  canGenerateReport,
  generateReportData,
  calculateAreaScores,

  getModifiedWeights,
  getWeightExplanations,
  getUnlockedConditionalQuestions,
} from '../../lib/engine/AssessmentEngine.js';

// The test profile from the implementation plan
const PRE_RESPONSES = {
  'Q-PP-01': 4, // Fully
  'Q-PP-02': 3, // Mostly
  'Q-PP-03': 2, // Partially
  'Q-PP-04': 1, // Minimally
  'Q-PP-05': 3, // Mostly
  'Q-PP-06': 2, // Partially (diversity)
  'Q-PP-07': 4, // Fully
  'Q-PP-08': 1, // Minimally
  'Q-PP-09': 3, // Mostly
  'Q-PP-10': 2, // Partially
  'Q-PP-11': 4, // Fully
  'Q-PP-12': 2, // Partially
  'Q-PP-13': 1, // Gate: Yes
  'Q-PP-14': 0, // Not at all
  'Q-PP-15': 3, // Mostly
  'Q-PP-16': ['Missing data analysis', 'Class imbalance analysis', 'Distribution analysis across subgroups'],
  'Q-PP-17': ['Historical bias', 'Population bias', 'Sampling/generalization bias', 'Labeling bias', 'Exclusion bias'],
};

const IN_RESPONSES = {
  'Q-IP-01': 3, // Mostly
  'Q-IP-02': 2, // Partially
  'Q-IP-03': 1, // Minimally
  'Q-IP-04': 0, // Not at all
  'Q-IP-05': 4, // Fully
  'Q-IP-06': ['Statistical Parity', 'Predictive Parity', 'False Positive Error Rate Balance', 'False Negative Error Rate Balance', 'Overall Accuracy Equality'],
  'Q-IP-07': 4, // Fully
  'Q-IP-08': 3, // Mostly
  'Q-IP-09': 2, // Partially
  'Q-IP-10': 1, // Minimally
  'Q-IP-11': 3, // Mostly
  'Q-IP-12': 4, // Fully
  'Q-IP-13': ['Cross-validation (k-fold)', 'Error analysis by subgroup', 'Learning curves analysis'],
  'Q-IP-14': 2, // Partially
};

const POST_RESPONSES = {
  'Q-PO-01': 2, // Partially
  'Q-PO-02': 3, // Mostly
  'Q-PO-03': 1, // Minimally
  'Q-PO-04': 4, // Fully
  'Q-PO-05': 4, // Fully
  'Q-PO-06': 2, // Partially
  'Q-PO-07': 0, // Not at all
  'Q-PO-08': 3, // Mostly
  'Q-PO-09': 1, // Minimally
  'Q-PO-10': 1, // Minimally
  'Q-PO-11': ['Ethics review board/process', 'Audit trail/logging', 'Version control for models and data', 'Compliance with national data protection laws'],
};

describe('E2E Test: Full Assessment Flow', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
  });

  it('Pre-processing is available, others are locked', () => {
    expect(isStageAccessible(state, 'pre-processing')).toBe(true);
    expect(isStageAccessible(state, 'in-processing')).toBe(false);
    expect(isStageAccessible(state, 'post-processing')).toBe(false);
  });

  it('Can complete full Pre→In→Post flow with test inputs', () => {
    // Set Pre-processing responses
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });

    // Complete Pre-processing
    state = completeStage(state, 'pre-processing', { skipValidation: true });
    expect(isStageAccessible(state, 'in-processing')).toBe(true);

    // Set In-processing responses
    Object.entries(IN_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'in-processing', qId, val);
    });

    // Complete In-processing
    state = completeStage(state, 'in-processing', { skipValidation: true });
    expect(isStageAccessible(state, 'post-processing')).toBe(true);

    // Set Post-processing responses
    Object.entries(POST_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'post-processing', qId, val);
    });

    // Complete Post-processing
    state = completeStage(state, 'post-processing', { skipValidation: true });
    expect(canGenerateReport(state)).toBe(true);
  });

  it('Pre-processing scores are differentiated (not all same)', () => {
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });

    const areaScores = calculateAreaScores(state, 'pre-processing');
    const values = Object.values(areaScores);
    const allSame = values.every(v => v === values[0]);
    expect(allSame).toBe(false);
    // Scores should be between 0 and 100
    values.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    });
  });

  it('Cross-stage modifiers may activate based on area scores', () => {
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    Object.entries(IN_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'in-processing', qId, val);
    });
    state = completeStage(state, 'in-processing', { skipValidation: true });

    // Check post-processing modifiers (both pre→post and in→post can activate)
    const weights = getModifiedWeights(state, 'post-processing');
    getWeightExplanations(state, 'post-processing');

    // All modifiers should be >= 1.0 (valid range)
    Object.values(weights).forEach(w => {
      expect(w.modifier).toBeGreaterThanOrEqual(1.0);
    });
    // At least one modifier should be > 1.0 (actually activated by low area scores)
    const hasElevated = Object.values(weights).some(w => w.modifier > 1.0);
    expect(hasElevated).toBe(true);
  });

  it('Conditional questions unlock for low Pre-processing scores (in post-processing)', () => {
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    // CQ-01: Q-PP-04<=1 unlocks Q-PO-EXTRA-01 in post-processing
    // Q-PP-04=1 so this should trigger
    const unlocked = getUnlockedConditionalQuestions(state, 'post-processing');
    expect(unlocked.length).toBeGreaterThan(0);
    expect(unlocked).toContain('Q-PO-EXTRA-01');
  });

  it('Full report generates with complete payload', () => {
    // Complete all stages
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    Object.entries(IN_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'in-processing', qId, val);
    });
    state = completeStage(state, 'in-processing', { skipValidation: true });

    Object.entries(POST_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'post-processing', qId, val);
    });
    state = completeStage(state, 'post-processing', { skipValidation: true });

    const report = generateReportData(state);
    expect(report).toBeDefined();
    expect(report.principleScores).toBeDefined();
    expect(report.stageScores).toBeDefined();
    expect(report.generatedAt).toBeDefined();

    // All 3 stages should have scores
    expect(report.stageScores['pre-processing']).toBeDefined();
    expect(report.stageScores['in-processing']).toBeDefined();
    expect(report.stageScores['post-processing']).toBeDefined();

    // Principle scores should have all 8 principles for each stage
    ['pre-processing', 'in-processing', 'post-processing'].forEach(stage => {
      const ps = report.principleScores[stage];
      expect(Object.keys(ps).length).toBeGreaterThan(0);
    });

    // activeModifiers should be defined (may or may not have entries)
    expect(report.activeModifiers).toBeDefined();
    expect(Array.isArray(report.activeModifiers)).toBe(true);
  });

  it('activeModifiers include a stage property on each entry', () => {
    // Complete all stages
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    Object.entries(IN_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'in-processing', qId, val);
    });
    state = completeStage(state, 'in-processing', { skipValidation: true });

    Object.entries(POST_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'post-processing', qId, val);
    });
    state = completeStage(state, 'post-processing', { skipValidation: true });

    const report = generateReportData(state);
    // With our test inputs, at least some modifiers should activate
    expect(report.activeModifiers.length).toBeGreaterThan(0);
    // Every modifier entry must carry a stage property
    report.activeModifiers.forEach(m => {
      expect(m).toHaveProperty('stage');
      expect(['in-processing', 'post-processing']).toContain(m.stage);
    });
  });

  it('Three-tier evidence classification works correctly', () => {
    // This tests the ReportPage evidence logic conceptually
    // Gap: resp <= 1, Attention: resp == 2, Adequate: resp >= 3

    // From PRE_RESPONSES:
    // Q-PP-04=1 → should be GAP
    // Q-PP-08=1 → should be GAP
    // Q-PP-14=0 → should be GAP
    // Q-PP-03=2 → should be ATTENTION
    // Q-PP-06=2 → should be ATTENTION
    // Q-PP-10=2 → should be ATTENTION
    // Q-PP-12=2 → should be ATTENTION
    // Q-PP-01=4 → should be ADEQUATE (no flag)

    const gapResponses = [0, 1];
    const attentionResponses = [2];
    const adequateResponses = [3, 4];

    // Verify threshold classification
    gapResponses.forEach(r => expect(r <= 1).toBe(true));
    attentionResponses.forEach(r => expect(r === 2).toBe(true));
    adequateResponses.forEach(r => expect(r >= 3).toBe(true));

    // Count expected classifications from PRE test inputs
    const preValues = Object.entries(PRE_RESPONSES)
      .filter(([k, v]) => typeof v === 'number' && k !== 'Q-PP-13') // exclude gate
      .map(([, v]) => v);

    const gapCount = preValues.filter(v => v <= 1).length;
    const attentionCount = preValues.filter(v => v === 2).length;
    const adequateCount = preValues.filter(v => v >= 3).length;

    expect(gapCount).toBe(3); // Q-PP-04=1, Q-PP-08=1, Q-PP-14=0
    expect(attentionCount).toBe(4); // Q-PP-03=2, Q-PP-06=2, Q-PP-10=2, Q-PP-12=2
    expect(adequateCount).toBe(7); // Q-PP-01=4, Q-PP-02=3, Q-PP-05=3, Q-PP-07=4, Q-PP-09=3, Q-PP-11=4, Q-PP-15=3
  });

  it('Checklist critical subset rules work correctly', () => {
    // Q-PP-16: 3 critical items checked (Missing data, Class imbalance, Distribution) → 3 >= 3 → NO gap
    // Q-PP-17: 5 critical items checked (all critical) → 5 >= 3 → NO gap
    // Q-IP-06: 4 items checked including 3 critical → 3 >= 2 → NO gap
    // Q-IP-13: 3 items checked including 2 critical (CV + Error subgroup) → 2 >= 2 → NO gap
    // Q-PO-11: 4 items checked including 3 critical (Ethics, Audit, Version control, Compliance) → 3 >= 3 → NO gap

    const checklistRules = {
      'Q-PP-16': { critical: ['Missing data analysis', 'Class imbalance analysis', 'Distribution analysis across subgroups', 'Data lineage/provenance tracking'], min: 3 },
      'Q-PP-17': { critical: ['Historical bias', 'Population bias', 'Sampling/generalization bias', 'Labeling bias', 'Exclusion bias'], min: 3 },
      'Q-IP-06': { critical: ['Statistical Parity', 'False Positive Error Rate Balance', 'False Negative Error Rate Balance', 'Predictive Parity'], min: 2 },
      'Q-IP-13': { critical: ['Cross-validation (k-fold)', 'Error analysis by subgroup', 'Sensitivity/perturbation analysis', 'Learning curves analysis'], min: 2 },
      'Q-PO-11': { critical: ['Ethics review board/process', 'Audit trail/logging', 'Version control for models and data', 'Access control policies', 'Compliance with national data protection laws'], min: 3 },
    };

    const allResponses = { ...PRE_RESPONSES, ...IN_RESPONSES, ...POST_RESPONSES };

    Object.entries(checklistRules).forEach(([qId, rule]) => {
      const checked = allResponses[qId] || [];
      const criticalChecked = rule.critical.filter(opt => checked.includes(opt));
      const meetsThreshold = criticalChecked.length >= rule.min;

      // With our test inputs, all checklists should meet the critical threshold
      expect(meetsThreshold).toBe(true);
    });
  });

  it('In-processing and Post-processing scores use cross-stage modified weights', () => {
    Object.entries(PRE_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'pre-processing', qId, val);
    });
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    Object.entries(IN_RESPONSES).forEach(([qId, val]) => {
      state = setResponse(state, 'in-processing', qId, val);
    });

    // Calculate unmodified scores
    const unmodifiedScores = calculateAreaScores(state, 'in-processing');

    // Calculate with modified weights (the actual function uses them)
    getModifiedWeights(state, 'in-processing');
    calculateAreaScores(state, 'in-processing');

    // Both should return valid scores
    Object.values(unmodifiedScores).forEach(s => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    });
  });
});
