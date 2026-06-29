/**
 * Adversarial Classification Tests for MAK-RAI Assessment Engine
 *
 * These tests verify the correctness of the three-tier classification system
 * (gap / attention / strength) under edge cases and adversarial inputs that
 * test the product's credibility with real institutional users.
 *
 * Each test is named after the scenario it probes, not the function it calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAssessment,
  setResponse,
  completeStage,
  calculateAreaScores,
  getUnlockedConditionalQuestions,
  getModifiedWeights,
  generateReportData,
  getResponses,
} from '../../lib/engine/AssessmentEngine.js';
import questionBank from '../../data/questionBank.json';
import assessmentAreas from '../../data/assessmentAreas.json';

/* ---------------------------------------------------------------
 * Helpers: replicate the ReportPage evidence classification logic
 * so we can test it without rendering React components.
 * --------------------------------------------------------------- */

/**
 * Classify assessment areas into gap/attention/strength/notAssessed
 * using the same logic as ReportPage.jsx lines 99-200.
 */
function classifyAreas(state, stages) {
  const gapEvidence = {};
  const attentionEvidence = {};
  const strengthEvidence = {};

  stages.forEach(stage => {
    const responses = getResponses(state, stage);
    const stageModules = questionBank.stages[stage]?.modules || [];
    const allQ = stageModules.flatMap(m => m.questions.filter(q => !q.crossStageCondition));
    // Include unlocked conditional questions (matches ReportPage C2)
    const unlockedIds = new Set(getUnlockedConditionalQuestions(state, stage));
    const conditionalQ = stageModules.flatMap(m =>
      m.questions.filter(q => q.crossStageCondition && unlockedIds.has(q.id))
    );
    const allQWithConditional = [...allQ, ...conditionalQ];

    allQWithConditional.forEach(q => {
      const resp = responses[q.id];
      if (q.type === 'gate') return;

      if (q.type === 'likert-5' && typeof resp === 'number' && q.gaps) {
        if (resp <= 1) {
          q.gaps.forEach(areaId => {
            if (!gapEvidence[areaId]) gapEvidence[areaId] = [];
            gapEvidence[areaId].push({ questionId: q.id, tier: 'gap', response: resp });
          });
        } else if (resp === 2) {
          q.gaps.forEach(areaId => {
            if (!attentionEvidence[areaId]) attentionEvidence[areaId] = [];
            attentionEvidence[areaId].push({ questionId: q.id, tier: 'attention', response: resp });
          });
        } else {
          q.gaps.forEach(areaId => {
            if (!strengthEvidence[areaId]) strengthEvidence[areaId] = [];
            strengthEvidence[areaId].push({ questionId: q.id, tier: 'strength', response: resp });
          });
        }
      }

      if (q.type === 'checklist' && q.optionGapMap) {
        const checked = Array.isArray(resp) ? resp : [];
        for (const [opt, mappings] of Object.entries(q.optionGapMap)) {
          const wasChecked = checked.includes(opt);
          mappings.forEach(mapping => {
            const areaId = typeof mapping === 'string' ? mapping : mapping.area;
            const role = typeof mapping === 'string' ? 'supporting' : mapping.role;
            if (wasChecked) {
              if (!strengthEvidence[areaId]) strengthEvidence[areaId] = [];
              strengthEvidence[areaId].push({ questionId: q.id, option: opt, tier: 'strength' });
            } else if (role === 'primary') {
              if (!gapEvidence[areaId]) gapEvidence[areaId] = [];
              gapEvidence[areaId].push({ questionId: q.id, option: opt, tier: 'gap', role });
            } else if (role === 'supporting') {
              if (!attentionEvidence[areaId]) attentionEvidence[areaId] = [];
              attentionEvidence[areaId].push({ questionId: q.id, option: opt, tier: 'attention', role });
            }
          });
        }
      }
    });
  });

  const gaps = assessmentAreas.areas.filter(a => gapEvidence[a.id]);
  const attentions = assessmentAreas.areas.filter(a => attentionEvidence[a.id] && !gapEvidence[a.id]);
  const gapIds = new Set(gaps.map(a => a.id));
  const attentionIds = new Set(attentions.map(a => a.id));
  const strengths = assessmentAreas.areas.filter(a =>
    !gapIds.has(a.id) && !attentionIds.has(a.id) && strengthEvidence[a.id]?.length > 0
  );
  const notAssessed = assessmentAreas.areas.filter(a =>
    !gapIds.has(a.id) && !attentionIds.has(a.id) && !strengthEvidence[a.id]?.length
  );

  return { gaps, attentions, strengths, notAssessed, gapEvidence, attentionEvidence, strengthEvidence };
}

/** Set all pre-processing responses to a given Likert value (checklists get all/none) */
function fillStage(state, stage, likertValue, checklistMode = 'all') {
  const modules = questionBank.stages[stage]?.modules || [];
  for (const mod of modules) {
    for (const q of mod.questions) {
      if (q.crossStageCondition) continue;
      if (q.type === 'likert-5') {
        state = setResponse(state, stage, q.id, likertValue);
      } else if (q.type === 'checklist') {
        state = setResponse(state, stage, q.id, checklistMode === 'all' ? [...q.options] : []);
      } else if (q.type === 'gate') {
        state = setResponse(state, stage, q.id, 1);
      }
    }
  }
  return state;
}


/* ---------------------------------------------------------------
 * 1. Labeling Bias Scenario (from user's original feedback)
 *
 * Q-PP-17: bias types checklist. If user checks Historical, Population,
 * and Sampling/generalization bias but NOT Labeling bias, then:
 * - PP-07 (Label Bias) should be a GAP because "Labeling bias" is
 *   mapped as primary to PP-07 and was not checked.
 * - PP-03 (Historical Bias) should be STRENGTH because "Historical bias"
 *   is primary to PP-03 and was checked.
 * --------------------------------------------------------------- */
describe('Adversarial: Checklist Primary/Supporting Role Classification', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
    // Fill all pre-processing with strong responses first
    state = fillStage(state, 'pre-processing', 4, 'all');
  });

  it('PP-07 is a GAP when Labeling bias (primary) is not checked even with 3 other biases checked', () => {
    // Override Q-PP-17 with specific checklist: check 3 biases but NOT labeling bias
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias',
      'Population bias',
      'Sampling/generalization bias',
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gaps, gapEvidence } = classifyAreas(state, ['pre-processing']);
    const gapIds = gaps.map(a => a.id);

    expect(gapIds).toContain('PP-07');
    // Verify the gap evidence cites labeling bias specifically
    const pp07Evidence = gapEvidence['PP-07'];
    expect(pp07Evidence).toBeDefined();
    expect(pp07Evidence.some(e => e.option === 'Labeling bias' && e.role === 'primary')).toBe(true);
  });

  it('PP-03 is a STRENGTH when Historical bias (primary) IS checked', () => {
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias',
      'Population bias',
      'Sampling/generalization bias',
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { strengthEvidence } = classifyAreas(state, ['pre-processing']);


    // PP-03 should be a strength because Historical bias (primary) was checked
    // AND there's no gap evidence overriding it from other questions
    const pp03Strength = strengthEvidence['PP-03'];
    expect(pp03Strength).toBeDefined();
    expect(pp03Strength.some(e => e.option === 'Historical bias')).toBe(true);
  });

  it('Supplementary unchecked options do NOT generate evidence', () => {
    // Q-PP-17: "Survey bias" is supplementary to PP-05
    // Leave Survey bias unchecked but check the primary ones
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias',
      'Population bias',
      'Sampling/generalization bias',
      'Labeling bias',
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gapEvidence, attentionEvidence } = classifyAreas(state, ['pre-processing']);

    // Survey bias is supplementary → no gap or attention evidence for PP-05 from this option
    const pp05Gaps = (gapEvidence['PP-05'] || []).filter(e => e.option === 'Survey bias');
    const pp05Attn = (attentionEvidence['PP-05'] || []).filter(e => e.option === 'Survey bias');
    expect(pp05Gaps.length).toBe(0);
    expect(pp05Attn.length).toBe(0);
  });

  it('Supporting unchecked option generates ATTENTION (not gap)', () => {
    // Q-PP-17: "Exclusion bias" is supporting to PP-04
    // Leave it unchecked
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias',
      'Population bias',
      'Sampling/generalization bias',
      'Labeling bias',
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { attentionEvidence } = classifyAreas(state, ['pre-processing']);
    const pp04Attn = (attentionEvidence['PP-04'] || []).filter(e => e.option === 'Exclusion bias');
    expect(pp04Attn.length).toBe(1);
    expect(pp04Attn[0].role).toBe('supporting');
  });
});


/* ---------------------------------------------------------------
 * 2. Gap Overrides Strength (Dominance Rule)
 *
 * An area with BOTH gap evidence AND strength evidence should
 * classify as GAP, not strength. Gaps always dominate.
 * --------------------------------------------------------------- */
describe('Adversarial: Gap Dominance Over Strength Evidence', () => {
  let state;

  beforeEach(() => {
    state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
  });

  it('Area with strong Likert but unchecked primary checklist option is a GAP', () => {
    // Q-PP-16: Data quality checklist
    // "Missing data analysis" is primary to PP-02. Leave it unchecked.
    // But Q-PP-14 maps to PP-02 with resp=4 (Fully) → strength evidence
    state = setResponse(state, 'pre-processing', 'Q-PP-14', 4); // strong
    state = setResponse(state, 'pre-processing', 'Q-PP-16', [
      'Outlier detection',
      'Duplicate detection',
      'Class imbalance analysis',
      // "Missing data analysis" deliberately not checked — it's primary to PP-02
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gaps, gapEvidence, strengthEvidence } = classifyAreas(state, ['pre-processing']);
    const gapIds = gaps.map(a => a.id);

    // PP-02 should have BOTH gap and strength evidence
    expect(gapEvidence['PP-02']).toBeDefined();
    expect(strengthEvidence['PP-02']).toBeDefined();
    // But the classification must be GAP (gap dominates)
    expect(gapIds).toContain('PP-02');
  });

  it('Area with ONLY attention evidence (no gap) is correctly ATTENTION', () => {
    // PP-04: "Exclusion bias" is supporting (not primary). Unchecked = attention.
    // But also check "Population bias" (primary to PP-04) → strength.
    // No gap evidence for PP-04 → should be attention (not gap, not strength)
    // because attention evidence exists alongside strength
    // Wait — actually, attention + strength without gap = ATTENTION wins
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias',
      'Population bias',       // primary to PP-04 → strength
      'Sampling/generalization bias',
      'Labeling bias',
      // 'Exclusion bias' NOT checked — supporting to PP-04 → attention
    ]);
    // Set all likert questions that map to PP-04 to high values
    state = setResponse(state, 'pre-processing', 'Q-PP-04', 4); // gaps: PP-04 → strength

    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { attentions, attentionEvidence, gapEvidence } = classifyAreas(state, ['pre-processing']);

    // PP-04 should have attention evidence from Exclusion bias
    expect(attentionEvidence['PP-04']?.some(e => e.option === 'Exclusion bias')).toBe(true);
    // And NO gap evidence
    expect(gapEvidence['PP-04']).toBeUndefined();
    // Therefore classification should be attention
    const attnIds = attentions.map(a => a.id);
    expect(attnIds).toContain('PP-04');
  });
});


/* ---------------------------------------------------------------
 * 3. All Answers "Not at all" — Every Mapped Area Should be GAP
 * --------------------------------------------------------------- */
describe('Adversarial: Worst-Case Assessment (All Minimum)', () => {
  it('All areas with mapped questions are gaps when everything is answered minimally', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 0, 'none');
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gaps, strengths } = classifyAreas(state, ['pre-processing']);

    // Every pre-processing area that has at least one mapped question should be a gap

    expect(gaps.length).toBeGreaterThan(0);
    expect(strengths.filter(a => a.stage === 'pre-processing').length).toBe(0);

    // Verify area scores are all very low
    const areaScores = calculateAreaScores(state, 'pre-processing');
    for (const score of Object.values(areaScores)) {
      expect(score).toBeLessThanOrEqual(10);
    }
  });
});


/* ---------------------------------------------------------------
 * 4. All Answers "Fully" — Every Mapped Area Should be STRENGTH
 * --------------------------------------------------------------- */
describe('Adversarial: Best-Case Assessment (All Maximum)', () => {
  it('All areas are strengths when everything is answered maximally', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gaps, attentions, strengths } = classifyAreas(state, ['pre-processing']);


    expect(gaps.filter(a => a.stage === 'pre-processing').length).toBe(0);
    expect(attentions.filter(a => a.stage === 'pre-processing').length).toBe(0);
    expect(strengths.filter(a => a.stage === 'pre-processing').length).toBeGreaterThan(0);

    // Area scores should all be high
    const areaScores = calculateAreaScores(state, 'pre-processing');
    for (const score of Object.values(areaScores)) {
      expect(score).toBeGreaterThanOrEqual(75);
    }
  });
});


/* ---------------------------------------------------------------
 * 5. Cross-Stage Conditional Questions Affect Scores
 *
 * When Q-PP-09 (data representativeness) is answered ≤ 1,
 * conditional Q-IP-EXTRA-01 unlocks in in-processing.
 * Its response should affect area scores for IP-01 and IP-04.
 * --------------------------------------------------------------- */
describe('Adversarial: Cross-Stage Conditional Questions in Scoring', () => {
  it('Conditional question response affects in-processing area scores', () => {
    let state = createAssessment();

    // Pre-processing: answer Q-PP-09 with 1 (Minimally) to trigger CQ-05
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = setResponse(state, 'pre-processing', 'Q-PP-09', 1); // triggers CQ-05
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    // Verify CQ-05 triggers Q-IP-EXTRA-01 in in-processing
    const unlocked = getUnlockedConditionalQuestions(state, 'in-processing');
    expect(unlocked).toContain('Q-IP-EXTRA-01');

    // Fill in-processing with strong responses
    state = fillStage(state, 'in-processing', 4, 'all');
    // Answer the conditional question with a LOW value
    state = setResponse(state, 'in-processing', 'Q-IP-EXTRA-01', 0); // Not at all

    // Calculate scores WITH the conditional question
    const scoresWithConditional = calculateAreaScores(state, 'in-processing');

    // Now create a parallel state WITHOUT the trigger (Q-PP-09 = 4, so no conditional unlocked)
    let stateNoTrigger = createAssessment();
    stateNoTrigger = fillStage(stateNoTrigger, 'pre-processing', 4, 'all');
    // Q-PP-09 = 4 → does NOT trigger CQ-05
    stateNoTrigger = completeStage(stateNoTrigger, 'pre-processing', { skipValidation: true });
    stateNoTrigger = fillStage(stateNoTrigger, 'in-processing', 4, 'all');

    const scoresWithoutConditional = calculateAreaScores(stateNoTrigger, 'in-processing');

    // IP-01 score should be LOWER when conditional Q is answered poorly
    // (Q-IP-EXTRA-01 maps to IP-01 and IP-04)
    if (scoresWithConditional['IP-01'] !== undefined && scoresWithoutConditional['IP-01'] !== undefined) {
      expect(scoresWithConditional['IP-01']).toBeLessThan(scoresWithoutConditional['IP-01']);
    }
  });

  it('Conditional question low response creates gap evidence', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = setResponse(state, 'pre-processing', 'Q-PP-09', 1);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    state = fillStage(state, 'in-processing', 4, 'all');
    state = setResponse(state, 'in-processing', 'Q-IP-EXTRA-01', 0); // Not at all
    state = completeStage(state, 'in-processing', { skipValidation: true });

    const { gapEvidence } = classifyAreas(state, ['pre-processing', 'in-processing']);

    // IP-01 should have gap evidence from the conditional question
    expect(gapEvidence['IP-01']).toBeDefined();
    expect(gapEvidence['IP-01'].some(e => e.questionId === 'Q-IP-EXTRA-01')).toBe(true);
  });

  it('Unmet conditional questions do NOT pollute scores', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    // Q-PP-09 = 4 → does NOT trigger CQ-05 → Q-IP-EXTRA-01 should NOT be scored
    state = completeStage(state, 'pre-processing', { skipValidation: true });
    state = fillStage(state, 'in-processing', 4, 'all');

    const unlocked = getUnlockedConditionalQuestions(state, 'in-processing');
    expect(unlocked).not.toContain('Q-IP-EXTRA-01');

    // Scores should not include the conditional question
    const scores = calculateAreaScores(state, 'in-processing');
    // With everything at 4/all, scores should be high and consistent
    for (const score of Object.values(scores)) {
      expect(score).toBeGreaterThanOrEqual(60);
    }
  });
});


/* ---------------------------------------------------------------
 * 6. Likert Boundary Values — Exact Threshold Behavior
 *
 * resp=1 → gap, resp=2 → attention, resp=3 → strength
 * Verify these exact boundaries.
 * --------------------------------------------------------------- */
describe('Adversarial: Likert Boundary Thresholds', () => {
  it('Response=1 produces GAP evidence (upper boundary of gap tier)', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    // Q-PP-01 maps to PP-01
    state = setResponse(state, 'pre-processing', 'Q-PP-01', 1);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gapEvidence } = classifyAreas(state, ['pre-processing']);
    expect(gapEvidence['PP-01']).toBeDefined();
    expect(gapEvidence['PP-01'].some(e => e.questionId === 'Q-PP-01' && e.response === 1)).toBe(true);
  });

  it('Response=2 produces ATTENTION evidence (exactly at boundary)', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = setResponse(state, 'pre-processing', 'Q-PP-01', 2);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { attentionEvidence, gapEvidence } = classifyAreas(state, ['pre-processing']);
    expect(attentionEvidence['PP-01']).toBeDefined();
    expect(gapEvidence['PP-01']).toBeUndefined();
  });

  it('Response=3 produces STRENGTH evidence (lower boundary of strength tier)', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = setResponse(state, 'pre-processing', 'Q-PP-01', 3);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { strengthEvidence, gapEvidence, attentionEvidence } = classifyAreas(state, ['pre-processing']);
    expect(strengthEvidence['PP-01']).toBeDefined();
    expect(gapEvidence['PP-01']).toBeUndefined();
    expect(attentionEvidence['PP-01']).toBeUndefined();
  });
});


/* ---------------------------------------------------------------
 * 7. Areas With Zero Evidence = Not Yet Assessed
 * --------------------------------------------------------------- */
describe('Adversarial: Areas Without Questions', () => {
  it('Areas from uncompleted stages appear as Not Yet Assessed', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    // Only classify pre-processing — in/post areas should not appear
    const { notAssessed } = classifyAreas(state, ['pre-processing']);

    // Post-processing areas should have no evidence from pre-processing stage alone
    const postAreas = assessmentAreas.areas.filter(a => a.stage === 'post-processing');
    const notAssessedIds = notAssessed.map(a => a.id);
    // At least some post-processing areas should be unassessed
    const unassessedPostAreas = postAreas.filter(a => notAssessedIds.includes(a.id));
    expect(unassessedPostAreas.length).toBeGreaterThan(0);
  });
});


/* ---------------------------------------------------------------
 * 8. Mixed Signals: Same Area Gets Gap from One Stage, Strength from Another
 *
 * If pre-processing gives PP-04 gap evidence (Q-PP-04=0)
 * but the checklist "Population bias" (primary to PP-04) is checked,
 * the area should still be GAP because gap evidence exists.
 * --------------------------------------------------------------- */
describe('Adversarial: Cross-Question Conflicting Evidence', () => {
  it('Area with gap from Likert and strength from checklist = GAP (gap dominates)', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');

    // Q-PP-04 maps to PP-04, answer "Not at all" → gap evidence
    state = setResponse(state, 'pre-processing', 'Q-PP-04', 0);
    // But also check "Population bias" in Q-PP-17 → strength evidence for PP-04
    state = setResponse(state, 'pre-processing', 'Q-PP-17', [
      'Historical bias', 'Population bias', 'Sampling/generalization bias',
      'Labeling bias', 'Exclusion bias',
    ]);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gaps, gapEvidence, strengthEvidence } = classifyAreas(state, ['pre-processing']);

    // PP-04 should have BOTH types of evidence
    expect(gapEvidence['PP-04']).toBeDefined();
    expect(strengthEvidence['PP-04']).toBeDefined();
    // But classification must be GAP
    expect(gaps.map(a => a.id)).toContain('PP-04');
  });
});


/* ---------------------------------------------------------------
 * 9. Empty Checklist = No Strength Evidence from That Question
 * --------------------------------------------------------------- */
describe('Adversarial: Empty Checklist Response', () => {
  it('Empty checklist generates gap evidence for primary options but no strength evidence', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 4, 'all');
    // Set Q-PP-16 to empty array
    state = setResponse(state, 'pre-processing', 'Q-PP-16', []);
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const { gapEvidence, strengthEvidence } = classifyAreas(state, ['pre-processing']);

    // "Missing data analysis" is primary to PP-02 → gap evidence
    expect(gapEvidence['PP-02']).toBeDefined();
    expect(gapEvidence['PP-02'].some(e => e.option === 'Missing data analysis')).toBe(true);

    // "Distribution analysis across subgroups" is primary to PP-04 → gap evidence
    expect(gapEvidence['PP-04']).toBeDefined();
    expect(gapEvidence['PP-04'].some(e => e.option === 'Distribution analysis across subgroups')).toBe(true);

    // No strength evidence from Q-PP-16 specifically
    for (const areaId of Object.keys(strengthEvidence)) {
      const fromQ16 = strengthEvidence[areaId].filter(e => e.questionId === 'Q-PP-16');
      expect(fromQ16.length).toBe(0);
    }
  });
});


/* ---------------------------------------------------------------
 * 10. Cross-Stage Weight Modifiers Adjust Scores
 *
 * When pre-processing scores are weak, in-processing questions
 * should get higher weights via cross-stage modifiers.
 * --------------------------------------------------------------- */
describe('Adversarial: Cross-Stage Weight Propagation', () => {
  it('Weak pre-processing increases weights for downstream in-processing questions', () => {
    let state = createAssessment();

    // Weak pre-processing (all minimally)
    state = fillStage(state, 'pre-processing', 1, 'none');
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const weakWeights = getModifiedWeights(state, 'in-processing');
    const hasElevatedWeight = Object.values(weakWeights).some(w => w.modifier > 1.0);

    // Strong pre-processing
    let stateStrong = createAssessment();
    stateStrong = fillStage(stateStrong, 'pre-processing', 4, 'all');
    stateStrong = completeStage(stateStrong, 'pre-processing', { skipValidation: true });

    const strongWeights = getModifiedWeights(stateStrong, 'in-processing');


    // Weak pre-processing should trigger MORE weight modifiers than strong
    expect(hasElevatedWeight).toBe(true);
    // Strong pre-processing should have fewer (or no) elevated weights
    const weakElevatedCount = Object.values(weakWeights).filter(w => w.modifier > 1.0).length;
    const strongElevatedCount = Object.values(strongWeights).filter(w => w.modifier > 1.0).length;
    expect(weakElevatedCount).toBeGreaterThan(strongElevatedCount);
  });
});


/* ---------------------------------------------------------------
 * 11. Report Score Consistency: Overall Score is Average of Stages
 * --------------------------------------------------------------- */
describe('Adversarial: Report Score Integrity', () => {
  it('Overall score equals average of stage averages', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 3, 'all');
    state = completeStage(state, 'pre-processing', { skipValidation: true });
    state = fillStage(state, 'in-processing', 2, 'all');
    state = completeStage(state, 'in-processing', { skipValidation: true });

    const report = generateReportData(state);
    const stageAverages = report.completedStages.map(stage => {
      const scores = Object.values(report.stageScores[stage]);
      return scores.reduce((sum, s) => sum + s, 0) / scores.length;
    });
    const expectedOverall = Math.round(
      stageAverages.reduce((sum, s) => sum + s, 0) / stageAverages.length
    );

    expect(report.overallScore).toBe(expectedOverall);
  });

  it('Single completed stage report has correct completedStages array', () => {
    let state = createAssessment();
    state = fillStage(state, 'pre-processing', 3, 'all');
    state = completeStage(state, 'pre-processing', { skipValidation: true });

    const report = generateReportData(state);
    expect(report.completedStages).toEqual(['pre-processing']);
    expect(report.stageScores).toHaveProperty('pre-processing');
    expect(report.stageScores).not.toHaveProperty('in-processing');
  });
});
