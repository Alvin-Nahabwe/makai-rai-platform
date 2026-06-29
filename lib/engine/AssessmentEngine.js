/**
 * AssessmentEngine.js
 *
 * Unified state management for the MAK-AI Responsible AI Assessment pipeline.
 * Manages a gated linear flow (Pre → In → Post) with cross-stage weight
 * propagation and conditional question unlocking.
 *
 * Design decisions documented in: docs/research/phase4-evidence-synthesis.md
 *
 * Key architectural choices:
 * - Immutable state updates (functions return new state, never mutate)
 * - sessionStorage persistence under key 'makai-unified-assessment'
 * - Weight modifier cap: 2.0× (safety constraint)
 * - Overlap strategy: max-not-product (ISO 31000 proportionate response)
 * - Sequential gating: Pre→In→Post (Suresh & Guttag 2021, Raji SMACTR 2020)
 */

import questionBank from '../../data/questionBank.json';
import scoringConfig from '../../data/scoringConfig.json';
import assessmentAreas from '../../data/assessmentAreas.json';

const STORAGE_KEY = 'makai-unified-assessment';
const VERSION = '4.0.0';

const STAGE_ORDER = ['pre-processing', 'in-processing', 'post-processing'];

/* ---------------------------------------------------------------
 * Core State Management (Task 4)
 * --------------------------------------------------------------- */

/**
 * Create a fresh assessment state object.
 * Pre-processing starts as 'available'; all other stages start 'locked'.
 */
export function createAssessment() {
  const now = new Date().toISOString();
  return {
    version: VERSION,
    createdAt: now,
    updatedAt: now,
    stages: {
      'pre-processing': { status: 'available', responses: {}, completedAt: null },
      'in-processing': { status: 'locked', responses: {}, completedAt: null },
      'post-processing': { status: 'locked', responses: {}, completedAt: null },
    },
  };
}

/** Get all responses for a given stage. */
export function getResponses(state, stage) {
  return state.stages[stage]?.responses || {};
}

/** Store a single response value (Likert index or checklist array). Returns new state. */
export function setResponse(state, stage, questionId, value) {
  // B4: Validate stage is accessible
  if (!isStageAccessible(state, stage)) {
    throw new Error(`Cannot set response on locked stage: "${stage}"`);
  }
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    stages: {
      ...state.stages,
      [stage]: {
        ...state.stages[stage],
        responses: {
          ...state.stages[stage].responses,
          [questionId]: value,
        },
      },
    },
  };
}

/** Get the status of a specific stage ('locked', 'available', or 'completed'). */
export function getStageStatus(state, stage) {
  return state.stages[stage]?.status || 'locked';
}

/** Persist state to localStorage (survives tab close and browser restart). */
export function saveState(state) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

/** Load state from localStorage, or return null if none exists. */
export function loadState() {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Clear persisted state from localStorage. */
export function clearState() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Reset assessment: clears persisted state and returns a fresh assessment. */
export function resetAssessment() {
  clearState();
  return createAssessment();
}

/* ---------------------------------------------------------------
 * Stage Gating Logic (Task 5)
 * --------------------------------------------------------------- */

/**
 * Mark a stage as completed and unlock the next stage.
 * Throws if the stage's prerequisite is not completed.
 * Options: { skipValidation: boolean } - skip response completeness check (for testing).
 */
export function completeStage(state, stage, options = {}) {
  const stageIndex = STAGE_ORDER.indexOf(stage);
  if (stageIndex < 0) {
    throw new Error(`Unknown stage: ${stage}`);
  }

  // Check prerequisite: previous stage must be completed (except for pre-processing)
  if (stageIndex > 0) {
    const previousStage = STAGE_ORDER[stageIndex - 1];
    if (state.stages[previousStage].status !== 'completed') {
      throw new Error(
        `Cannot complete "${stage}" — prerequisite "${previousStage}" is not completed.`
      );
    }
  }

  // B5: Validate all required questions are answered (unless skipped)
  if (!options.skipValidation) {
    const responses = getResponses(state, stage);
    const requiredQuestions = getRequiredQuestions(state, stage);
    const unanswered = requiredQuestions.filter(q => responses[q.id] === undefined);
    if (unanswered.length > 0) {
      throw new Error(
        `Cannot complete "${stage}" — ${unanswered.length} unanswered question(s): ${unanswered.map(q => q.id).join(', ')}`
      );
    }
  }

  const now = new Date().toISOString();
  const updatedStages = { ...state.stages };

  // Mark current stage as completed
  updatedStages[stage] = {
    ...updatedStages[stage],
    status: 'completed',
    completedAt: now,
  };

  // Unlock the next stage if one exists
  const nextIndex = stageIndex + 1;
  if (nextIndex < STAGE_ORDER.length) {
    const nextStage = STAGE_ORDER[nextIndex];
    updatedStages[nextStage] = {
      ...updatedStages[nextStage],
      status: 'available',
    };
  }

  return { ...state, updatedAt: now, stages: updatedStages };
}

/** Check if a stage is accessible (available or completed). */
export function isStageAccessible(state, stage) {
  const status = getStageStatus(state, stage);
  return status === 'available' || status === 'completed';
}

/** Get the next stage that needs attention (first non-completed stage). */
export function getNextStage(state) {
  for (const stage of STAGE_ORDER) {
    if (state.stages[stage].status !== 'completed') {
      return stage;
    }
  }
  return null;
}

/** Check if at least one stage has been completed (report can be generated). */
export function canGenerateReport(state) {
  return STAGE_ORDER.some(stage => state.stages[stage].status === 'completed');
}

/* ---------------------------------------------------------------
 * Score Calculation (Task 6)
 * --------------------------------------------------------------- */

/**
 * Get all questions for a stage (or all stages if stage is null).
 * Excludes conditional questions by default.
 * When state is provided, also excludes questions whose intra-stage gate
 * condition is not met (B2: gate enforcement).
 */
function getAllQuestionsForStage(stage, includeConditional = false, state = null) {
  const questions = [];
  const stages = stage ? { [stage]: questionBank.stages[stage] } : questionBank.stages;
  for (const [stageName, stageData] of Object.entries(stages)) {
    const stageResponses = state ? getResponses(state, stageName) : null;
    for (const mod of stageData.modules) {
      for (const q of mod.questions) {
        if (!includeConditional && q.crossStageCondition) continue;
        // B2: Enforce intra-stage gate conditions
        if (state && q.condition) {
          const gateResp = stageResponses?.[q.condition.questionId];
          if (q.condition.value !== undefined && gateResp !== q.condition.value) continue;
          if (q.condition.minValue !== undefined && (typeof gateResp !== 'number' || gateResp < q.condition.minValue)) continue;
        }
        questions.push(q);
      }
    }
  }
  return questions;
}

/**
 * Get required questions for a stage (non-conditional, non-gated-out).
 * Used by completeStage to validate completeness.
 */
function getRequiredQuestions(state, stage) {
  return getAllQuestionsForStage(stage, false, state).filter(q => q.type !== 'gate');
}

/**
 * Get all scorable questions for a stage: regular questions + unlocked conditionals.
 * This is the correct question set for scoring functions (calculateAreaScores,
 * calculatePrincipleScores, getModifiedWeights) — it ensures cross-stage
 * conditional questions that were triggered and answered by the user are
 * included in numeric scores, not just evidence classification.
 *
 * Cannot simply pass includeConditional=true to getAllQuestionsForStage because
 * that would include ALL conditionals (even ones whose trigger was not met).
 */
function getScoringQuestions(state, stage) {
  const regular = getAllQuestionsForStage(stage, false, state);
  const unlockedIds = new Set(getUnlockedConditionalQuestions(state, stage));
  if (unlockedIds.size === 0) return regular;

  const stageData = questionBank.stages[stage];
  if (!stageData) return regular;

  const unlocked = [];
  for (const mod of stageData.modules) {
    for (const q of mod.questions) {
      if (q.crossStageCondition && unlockedIds.has(q.id)) {
        unlocked.push(q);
      }
    }
  }
  return [...regular, ...unlocked];
}

/**
 * Normalize a response value to 0-1 range.
 * Likert-5 (index 0-4): value / 4, clamped to [0, 1]
 * Checklist (array of indices): selectedCount / totalOptions
 */
function normalizeResponse(question, value) {
  if (value === undefined || value === null) return 0;

  if (question.type === 'likert-5') {
    // B4: Clamp to valid range
    const clamped = Math.max(0, Math.min(4, typeof value === 'number' ? value : 0));
    return clamped / 4;
  }
  if (question.type === 'checklist' && Array.isArray(value)) {
    const totalOptions = question.options ? question.options.length : 1;
    return totalOptions > 0 ? Math.min(1, value.length / totalOptions) : 0;
  }
  if (question.type === 'gate') {
    return 0; // Gate questions don't contribute to scores
  }
  // Default: treat as Likert-5, clamped
  if (typeof value === 'number') {
    return Math.max(0, Math.min(1, value / 4));
  }
  return 0;
}

/**
 * Calculate scores per assessment area for a given stage.
 * Returns object: { areaId: score (0-100) }
 *
 * Weight normalization: Raw question weights (from questionBank.json) are
 * relative, not absolute — they do NOT need to sum to 1.0 per module.
 * This function computes a running `totalWeight` (sum of all applicable
 * weights for each area) and divides `weightedScore` by it, so the
 * resulting 0-100 score is independent of the magnitude of the raw weights.
 *
 * Scoring sources:
 * 1. Likert-5/gate questions mapped via q.gaps[]
 * 2. Checklist questions mapped via q.optionGapMap with role-based weighting
 *    (primary=1.0, supporting=0.6, supplementary=0.3)
 */
const ROLE_WEIGHTS = { primary: 1.0, supporting: 0.6, supplementary: 0.3 };

export function calculateAreaScores(state, stage) {
  const responses = getResponses(state, stage);
  const areas = (assessmentAreas.areas || []).filter(a => a.stage === stage);
  // Include unlocked cross-stage conditional questions in area scoring
  const questions = getScoringQuestions(state, stage);
  const modifiedWeights = getModifiedWeights(state, stage);

  // Build question lookup
  const questionMap = {};
  questions.forEach(q => { questionMap[q.id] = q; });

  // Also gather all checklist questions from ALL completed stages that have
  // optionGapMap entries referencing areas in this stage
  const allChecklistQuestions = [];
  for (const s of STAGE_ORDER) {
    if (state.stages[s].status !== 'completed' && s !== stage) continue;
    const sQuestions = getScoringQuestions(state, s);
    for (const q of sQuestions) {
      if (q.type === 'checklist' && q.optionGapMap) {
        allChecklistQuestions.push({ question: q, stage: s });
      }
    }
  }

  const areaScores = {};
  for (const area of areas) {
    let totalWeight = 0;
    let weightedScore = 0;

    // Source 1: Likert-5 questions mapped via gaps[]
    const areaQuestions = questions.filter(q => {
      if (!q.gaps) return false;
      return q.gaps.includes(area.id);
    });

    for (const q of areaQuestions) {
      const baseWeight = q.weight || 1;
      const crossMod = modifiedWeights[q.id]?.modifier || 1.0;
      const weight = baseWeight * crossMod;
      const response = responses[q.id];
      const normalized = normalizeResponse(q, response);
      weightedScore += normalized * weight;
      totalWeight += weight;
    }

    // Source 2: Checklist questions mapped via optionGapMap (B1)
    // Only include when the checklist question has been answered
    for (const { question: q, stage: qStage } of allChecklistQuestions) {
      const qResponses = getResponses(state, qStage);
      if (qResponses[q.id] === undefined) continue; // Skip unanswered checklists
      const checked = Array.isArray(qResponses[q.id]) ? qResponses[q.id] : [];

      for (const [opt, mappings] of Object.entries(q.optionGapMap)) {
        for (const mapping of mappings) {
          const areaId = typeof mapping === 'string' ? mapping : mapping.area;
          if (areaId !== area.id) continue;

          const role = typeof mapping === 'string' ? 'supporting' : mapping.role;
          const roleWeight = ROLE_WEIGHTS[role] || ROLE_WEIGHTS.supporting;
          const wasChecked = checked.includes(opt) ? 1.0 : 0.0;

          weightedScore += wasChecked * roleWeight;
          totalWeight += roleWeight;
        }
      }
    }

    areaScores[area.id] = totalWeight > 0
      ? Math.round((weightedScore / totalWeight) * 100)
      : 0;
  }

  return areaScores;
}

/**
 * Calculate scores per principle for a given stage.
 * Returns object: { principleLabel: score (0-100) }
 */
export function calculatePrincipleScores(state, stage) {
  const responses = getResponses(state, stage);
  // Include unlocked cross-stage conditional questions in principle scoring
  const questions = getScoringQuestions(state, stage);
  const modifiedWeights = getModifiedWeights(state, stage);
  const principleGroups = {};

  for (const q of questions) {
    const principle = q.principle;
    if (!principle) continue;

    if (!principleGroups[principle]) {
      principleGroups[principle] = { totalWeight: 0, weightedScore: 0 };
    }

    const baseWeight = q.weight || 1;
    const crossMod = modifiedWeights[q.id]?.modifier || 1.0;
    const weight = baseWeight * crossMod;
    const response = responses[q.id];
    const normalized = normalizeResponse(q, response);
    principleGroups[principle].weightedScore += normalized * weight;
    principleGroups[principle].totalWeight += weight;
  }

  const scores = {};
  for (const [principle, group] of Object.entries(principleGroups)) {
    scores[principle] = group.totalWeight > 0
      ? Math.round((group.weightedScore / group.totalWeight) * 100)
      : 0;
  }

  return scores;
}

/* ---------------------------------------------------------------
 * Cross-Stage Weight Propagation (Task 7)
 * --------------------------------------------------------------- */

/**
 * Determine which cross-stage weight rules are active given the current state.
 * Returns rules from the appropriate source→target direction.
 */
function getApplicableRules(state, targetStage) {
  const { crossStageWeights } = scoringConfig;
  const rules = [];

  if (targetStage === 'in-processing') {
    rules.push(...(crossStageWeights.pre_to_in || []));
  } else if (targetStage === 'post-processing') {
    rules.push(...(crossStageWeights.in_to_post || []));
    rules.push(...(crossStageWeights.pre_to_post || []));
  }
  // pre-processing has no upstream → no rules apply

  return rules;
}

/**
 * Calculate the area score for a specific area based on current responses.
 * Used internally to evaluate cross-stage rules.
 *
 * Recursion guard: getAreaScore → calculateAreaScores → getScoringQuestions →
 * getUnlockedConditionalQuestions, AND getModifiedWeights → getAreaScore →
 * calculateAreaScores. Today cross-stage rules only go forward (pre→in,
 * in→post, pre→post) so recursion doesn't happen in practice. The guard
 * prevents infinite loops if a same-stage or backward rule is ever added.
 */
const _areaScoreInProgress = new Set();

function getAreaScore(state, areaId) {
  const area = (assessmentAreas.areas || []).find(a => a.id === areaId);
  if (!area) {
    console.warn(`[AssessmentEngine] getAreaScore: unknown area "${areaId}". Returning 0.`);
    return 0; // Unknown area = no evidence of compliance
  }

  // Recursion guard: if we're already computing this area, return 0 to break the cycle
  if (_areaScoreInProgress.has(areaId)) {
    console.warn(`[AssessmentEngine] getAreaScore: recursion detected for area "${areaId}". Returning 0.`);
    return 0;
  }

  _areaScoreInProgress.add(areaId);
  try {
    const scores = calculateAreaScores(state, area.stage);
    return scores[areaId] !== undefined ? scores[areaId] : 0;
  } finally {
    _areaScoreInProgress.delete(areaId);
  }
}

/**
 * Get a single question's response value (for question-level triggers).
 */
function getQuestionScore(state, questionId) {
  // Find which stage this question belongs to
  for (const stage of STAGE_ORDER) {
    const responses = getResponses(state, stage);
    if (responses[questionId] !== undefined) {
      return responses[questionId];
    }
  }
  return undefined;
}

/**
 * Calculate modified weights for all questions in a target stage.
 * Returns: { questionId: { modifier: number, rules: string[] } }
 *
 * Design: max-not-product overlap strategy, capped at modifierCap (2.0×).
 * Evidence: ISO 31000 proportionate response principle.
 */
export function getModifiedWeights(state, targetStage) {
  // Include unlocked cross-stage conditional questions in weight modification
  const questions = getScoringQuestions(state, targetStage);
  const rules = getApplicableRules(state, targetStage);
  const cap = scoringConfig.crossStageWeights?.modifierCap || 2.0;

  // Initialize all questions with modifier 1.0
  const weights = {};
  for (const q of questions) {
    weights[q.id] = { modifier: 1.0, rules: [] };
  }

  // Evaluate each rule
  for (const rule of rules) {
    let sourceScore;

    if (rule.sourceMetric === 'areaScore') {
      sourceScore = getAreaScore(state, rule.sourceArea);
    } else if (rule.sourceMetric === 'questionScore') {
      sourceScore = getQuestionScore(state, rule.sourceQuestion);
    } else {
      continue;
    }

    // Check if the source score is below the threshold
    const belowThreshold = rule.sourceMetric === 'questionScore'
      ? sourceScore !== undefined && sourceScore <= rule.threshold
      : sourceScore < rule.threshold;

    if (!belowThreshold) continue;

    // Apply modifier to target questions (max strategy)
    for (const targetQId of rule.targetQuestions) {
      if (weights[targetQId]) {
        weights[targetQId].modifier = Math.min(
          cap,
          Math.max(weights[targetQId].modifier, rule.modifier)
        );
        weights[targetQId].rules.push(rule.id);
      }
    }
  }

  return weights;
}

/**
 * Get human-readable explanations for all active weight modifiers.
 * Returns array of { questionId, modifier, ruleId, rationale, citation }.
 */
export function getWeightExplanations(state, targetStage) {
  const weights = getModifiedWeights(state, targetStage);
  const rules = getApplicableRules(state, targetStage);
  const ruleMap = {};
  rules.forEach(r => { ruleMap[r.id] = r; });

  // Build a flat map of all question IDs → question text for lookups
  const qTextMap = {};
  for (const stage of STAGE_ORDER) {
    const modules = questionBank.stages[stage]?.modules || [];
    modules.forEach(m => m.questions.forEach(q => { qTextMap[q.id] = q.text; }));
  }

  const explanations = [];
  for (const [questionId, weight] of Object.entries(weights)) {
    if (weight.modifier > 1.0) {
      for (const ruleId of weight.rules) {
        const rule = ruleMap[ruleId];
        if (rule) {
          // Build source trigger info
          const sourceInfo = {};
          if (rule.sourceMetric === 'areaScore' && rule.sourceArea) {
            const area = (assessmentAreas.areas || []).find(a => a.id === rule.sourceArea);
            sourceInfo.type = 'area';
            sourceInfo.areaId = rule.sourceArea;
            sourceInfo.areaName = area?.name || rule.sourceArea;
            sourceInfo.areaScore = getAreaScore(state, rule.sourceArea);
            sourceInfo.threshold = rule.threshold;
          } else if (rule.sourceMetric === 'questionScore' && rule.sourceQuestion) {
            sourceInfo.type = 'question';
            sourceInfo.questionId = rule.sourceQuestion;
            sourceInfo.questionText = qTextMap[rule.sourceQuestion] || rule.sourceQuestion;
            sourceInfo.questionScore = getQuestionScore(state, rule.sourceQuestion);
            sourceInfo.threshold = rule.threshold;
          }

          explanations.push({
            questionId,
            questionText: qTextMap[questionId] || questionId,
            modifier: weight.modifier,
            ruleId,
            rationale: rule.rationale,
            citation: rule.citation,
            source: sourceInfo,
          });
        }
      }
    }
  }

  return explanations;
}

/* ---------------------------------------------------------------
 * Conditional Question Unlocking (Task 8)
 * --------------------------------------------------------------- */

/**
 * Get question IDs unlocked by conditional triggers for a target stage.
 * Returns array of question IDs (e.g., ['Q-PO-EXTRA-01', 'Q-PO-EXTRA-02']).
 */
export function getUnlockedConditionalQuestions(state, targetStage) {
  const { conditionalQuestions } = scoringConfig;
  if (!conditionalQuestions) return [];

  const unlocked = [];

  for (const cq of conditionalQuestions) {
    if (cq.unlock.stage !== targetStage) continue;

    // Find the trigger question's response
    const triggerValue = getQuestionScore(state, cq.trigger.questionId);
    if (triggerValue === undefined) continue;

    // Evaluate the condition (e.g., "value <= 1")
    const conditionMet = evaluateCondition(triggerValue, cq.trigger.condition);
    if (conditionMet) {
      unlocked.push(...cq.unlock.questionIds);
    }
  }

  return unlocked;
}

/**
 * Evaluate a simple condition string against a value.
 * Supports: "value <= N", "value < N", "value == N", "value >= N", "value > N"
 * B3: Array values (checklists) are converted to their length for comparison.
 */
function evaluateCondition(value, conditionStr) {
  const match = conditionStr.match(/value\s*(<=|>=|<|>|==|!=)\s*(\d+\.?\d*)/);
  if (!match) return false;

  const operator = match[1];
  const threshold = parseFloat(match[2]);

  // B3: Convert array values to their length for numeric comparison
  const compareValue = Array.isArray(value) ? value.length : value;

  switch (operator) {
    case '<=': return compareValue <= threshold;
    case '>=': return compareValue >= threshold;
    case '<':  return compareValue < threshold;
    case '>':  return compareValue > threshold;
    case '==': return compareValue === threshold;
    case '!=': return compareValue !== threshold;
    default:   return false;
  }
}

/**
 * Get all visible questions for a stage, merging regular and unlocked conditional questions.
 * Conditional questions are only included if their trigger condition is met.
 */
export function getVisibleQuestions(state, targetStage) {
  const regularQuestions = getAllQuestionsForStage(targetStage, false);
  const unlockedIds = new Set(getUnlockedConditionalQuestions(state, targetStage));

  if (unlockedIds.size === 0) return regularQuestions;

  // Get conditional questions from the question bank
  const conditionalQuestions = [];
  const stageData = questionBank.stages[targetStage];
  if (stageData) {
    for (const mod of stageData.modules) {
      for (const q of mod.questions) {
        if (q.crossStageCondition && unlockedIds.has(q.id)) {
          conditionalQuestions.push(q);
        }
      }
    }
  }

  return [...regularQuestions, ...conditionalQuestions];
}

/* ---------------------------------------------------------------
 * Report Data Generation (Task 9)
 * --------------------------------------------------------------- */

/**
 * Generate a complete report payload from the current state.
 * Includes all completed stages, their scores, active modifiers, and unlocked conditionals.
 */
export function generateReportData(state) {
  const completedStages = STAGE_ORDER.filter(
    stage => state.stages[stage].status === 'completed'
  );

  const stageScores = {};
  const principleScores = {};
  const allModifiers = [];
  const allConditionals = [];

  for (const stage of completedStages) {
    stageScores[stage] = calculateAreaScores(state, stage);
    principleScores[stage] = calculatePrincipleScores(state, stage);
  }

  // Collect modifiers only for completed stages that have upstream completed stages
  for (const stage of completedStages) {
    if (stage === 'pre-processing') continue;
    const explanations = getWeightExplanations(state, stage);
    allModifiers.push(...explanations.map(e => ({ ...e, stage })));
  }

  // Collect unlocked conditionals for all stages
  for (const stage of STAGE_ORDER) {
    const unlocked = getUnlockedConditionalQuestions(state, stage);
    if (unlocked.length > 0) {
      allConditionals.push({ stage, questionIds: unlocked });
    }
  }

  // Calculate overall lifecycle score (average of completed stage averages)
  let overallScore = 0;
  if (completedStages.length > 0) {
    const stageAverages = completedStages.map(stage => {
      const scores = Object.values(stageScores[stage]);
      return scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;
    });
    overallScore = Math.round(
      stageAverages.reduce((sum, s) => sum + s, 0) / stageAverages.length
    );
  }

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    completedStages,
    overallScore,
    stageScores,
    principleScores,
    activeModifiers: allModifiers,
    unlockedConditionals: allConditionals,
  };
}
