'use client';

import { useMemo } from 'react';
import questionBankRaw from '@/data/questionBank.json';
import assessmentAreasRaw from '@/data/assessmentAreas.json';
import { ratingLabels } from '@/data/constants';
import { getUnlockedConditionalQuestions, getResponses } from '@/lib/engine/AssessmentEngine.js';
import type {
  QuestionBank,
  AssessmentAreasData,
  AssessmentArea,
  Control,
  Question,
  OptionMapping,
  EngineState,
  ReportData,
  ResponseValue,
} from '@/types/domain';

const questionBank = questionBankRaw as unknown as QuestionBank;
const assessmentAreas = assessmentAreasRaw as unknown as AssessmentAreasData;

/** Evidence item produced by the hook. */
export interface EvidenceItem {
  questionId: string;
  questionText: string;
  stage: string;
  reason: string;
  detail?: string;
  tier: 'gap' | 'attention' | 'strength';
}

/** A question annotated with the user's response, used in principle results. */
type PrincipleQuestion = Question & { response?: ResponseValue; normalized: number };

/** Principle result for a single principle in a stage. */
export interface PrincipleResult {
  name: string;
  pct: number;
  level: string;
  questions: PrincipleQuestion[];
}

/** Return type of the useEvidenceData hook. */
export interface EvidenceData {
  allPrincipleResults: Record<string, PrincipleResult[]>;
  gaps: AssessmentArea[];
  attentions: AssessmentArea[];
  strengths: AssessmentArea[];
  notAssessed: AssessmentArea[];
  gapEvidence: Record<string, EvidenceItem[]>;
  attentionEvidence: Record<string, EvidenceItem[]>;
  strengthEvidence: Record<string, EvidenceItem[]>;
  controlsMap: Record<string, Control>;
}

/**
 * Derives the maturity level from a percentage score.
 * Kept here because the hook needs it for principle results.
 * Also re-exported so ReportPage can use it for overallLevel.
 */
export function getLevel(pct: number): string {
  if (pct >= 75) return 'low';
  if (pct >= 50) return 'moderate';
  if (pct >= 25) return 'high';
  return 'critical';
}

/**
 * Custom hook that memoizes the full evidence computation for the report.
 */
export function useEvidenceData(
  report: ReportData | null,
  engineState: EngineState | null,
): EvidenceData {
  return useMemo(() => {
    if (!report || !engineState || report.completedStages.length === 0) {
      return { allPrincipleResults: {}, gaps: [], attentions: [], strengths: [], notAssessed: [], gapEvidence: {}, attentionEvidence: {}, strengthEvidence: {}, controlsMap: {} };
    }

    /** Get all questions for a stage, including unlocked cross-stage conditionals. */
    function getStageQuestionsWithConditionals(stage: string): Question[] {
      const modules = questionBank.stages[stage]?.modules || [];
      const regular = modules.flatMap((m) => m.questions.filter((q) => !q.crossStageCondition));
      const unlockedIds = new Set(getUnlockedConditionalQuestions(engineState!, stage));
      const conditional = modules.flatMap((m) => m.questions.filter((q) => q.crossStageCondition && unlockedIds.has(q.id)));
      return [...regular, ...conditional];
    }

    const { completedStages, principleScores } = report;
    const allPrincipleResults: Record<string, PrincipleResult[]> = {};
  completedStages.forEach((stage: string) => {
    const scores = principleScores[stage] || {};
    const responses = getResponses(engineState!, stage);
    const allQ = getStageQuestionsWithConditionals(stage);

    allPrincipleResults[stage] = Object.entries(scores).map(([name, pct]) => {
      const questions: PrincipleQuestion[] = allQ.filter((q) => q.principle === name).map((q) => {
        const r = responses[q.id];
        return {
          ...q, response: r,
          normalized: q.type === 'likert-5' && typeof r === 'number' ? r / 4 : 0,
        };
      });
      return { name, pct, level: getLevel(pct), questions };
    }).sort((a, b) => a.pct - b.pct);
  });

  // Aggregate gap evidence across all completed stages — THREE-TIER system
  // Based on ISO 33020 (Process Measurement Framework) thresholds:
  //   0-1: Gap (Not achieved / lower Partially achieved)
  //   2:   Attention needed (P/L boundary)
  //   3-4: Adequate (Largely / Fully achieved)
  const gapEvidence: Record<string, EvidenceItem[]> = {};      // areaId → [{questionId, reason, detail, ...}]
  const attentionEvidence: Record<string, EvidenceItem[]> = {}; // areaId → [{questionId, reason, detail, ...}]
  const controlsMap: Record<string, Control> = {};
  assessmentAreas.controls.forEach((c) => { controlsMap[c.id] = c; });

  const strengthEvidence: Record<string, EvidenceItem[]> = {};

  completedStages.forEach((stage: string) => {
    const responses = getResponses(engineState!, stage);
    // C2: Include unlocked conditional questions in evidence gathering
    const allQWithConditional = getStageQuestionsWithConditionals(stage);

    allQWithConditional.forEach((q) => {
      const resp = responses[q.id];
      if (q.type === 'gate') return;

      // Likert-5: three-tier threshold
      if (q.type === 'likert-5' && typeof resp === 'number' && q.gaps) {
        if (resp <= 1) {
          // GAP — primary gap
          q.gaps.forEach((areaId: string) => {
            if (!gapEvidence[areaId]) gapEvidence[areaId] = [];
            gapEvidence[areaId].push({
              questionId: q.id, questionText: q.text, stage,
              reason: `Answered "${q.scale?.[resp]}" (${resp + 1}/5) — ${ratingLabels[resp]}`,
              detail: `This area needs significant improvement to meet the readiness threshold for responsible deployment.`,
              tier: 'gap',
            });
          });
        } else if (resp === 2) {
          // ATTENTION — warning tier
          q.gaps.forEach((areaId: string) => {
            if (!attentionEvidence[areaId]) attentionEvidence[areaId] = [];
            attentionEvidence[areaId].push({
              questionId: q.id, questionText: q.text, stage,
              reason: `Answered "${q.scale?.[resp]}" (${resp + 1}/5) — ${ratingLabels[resp]}`,
              detail: `This area is partially addressed but not yet strong enough. A targeted review could close the remaining gap.`,
              tier: 'attention',
            });
          });
        } else {
          // STRENGTH — resp >= 3
          q.gaps.forEach((areaId: string) => {
            if (!strengthEvidence[areaId]) strengthEvidence[areaId] = [];
            strengthEvidence[areaId].push({
              questionId: q.id, questionText: q.text, stage,
              reason: `Answered "${q.scale?.[resp]}" (${resp + 1}/5) — ${ratingLabels[resp]}`,
              tier: 'strength',
            });
          });
        }
      }

      // Checklist: role-based per-option-per-area evidence
      // Each option→area mapping has a role: primary, supporting, or supplementary
      // primary unchecked → gap, supporting unchecked → attention, supplementary unchecked → no evidence
      if (q.type === 'checklist' && q.optionGapMap) {
        const checked: string[] = Array.isArray(resp) ? resp : [];

        // Build full ✓/✗ breakdown for detail display (all options in the checklist)
        const detailStr = (q.options || []).map((opt: string) =>
          checked.includes(opt) ? `✓ ${opt}` : `✗ ${opt}`
        ).join(' · ');

        // For each option, determine its evidence tier based on role and push to mapped areas
        for (const [opt, mappings] of Object.entries(q.optionGapMap)) {
          const wasChecked = checked.includes(opt);

          mappings.forEach((mapping: string | OptionMapping) => {
            // Support both old format (string) and new format (object with area+role)
            const areaId = typeof mapping === 'string' ? mapping : mapping.area;
            const role = typeof mapping === 'string' ? 'supporting' : mapping.role;

            if (wasChecked) {
              // STRENGTH: this specific practice was assessed — always credited regardless of role
              if (!strengthEvidence[areaId]) strengthEvidence[areaId] = [];
              strengthEvidence[areaId].push({
                questionId: q.id, questionText: q.text, stage,
                reason: `Practice assessed: "${opt}"`,
                detail: detailStr,
                tier: 'strength',
              });
            } else if (role === 'primary') {
              // GAP: a primary practice not assessed — THE defining practice for this area
              if (!gapEvidence[areaId]) gapEvidence[areaId] = [];
              gapEvidence[areaId].push({
                questionId: q.id, questionText: q.text, stage,
                reason: `Critical practice not assessed: "${opt}"`,
                detail: detailStr,
                tier: 'gap',
              });
            } else if (role === 'supporting') {
              // ATTENTION: a supporting practice not assessed — meaningful but not defining
              if (!attentionEvidence[areaId]) attentionEvidence[areaId] = [];
              attentionEvidence[areaId].push({
                questionId: q.id, questionText: q.text, stage,
                reason: `Practice not assessed: "${opt}"`,
                detail: detailStr,
                tier: 'attention',
              });
            }
            // supplementary unchecked → no evidence generated (by design)
          });
        }
      }
    });
  });

  const gaps = assessmentAreas.areas.filter((a) => gapEvidence[a.id]);
  const attentions = assessmentAreas.areas.filter((a) => attentionEvidence[a.id] && !gapEvidence[a.id]);
  const gapIds = new Set(gaps.map((a) => a.id));
  const attentionIds = new Set(attentions.map((a) => a.id));
  const strengths = assessmentAreas.areas.filter((a) => !gapIds.has(a.id) && !attentionIds.has(a.id) && strengthEvidence[a.id]?.length > 0);
  const notAssessed = assessmentAreas.areas.filter((a) => !gapIds.has(a.id) && !attentionIds.has(a.id) && !strengthEvidence[a.id]?.length);

  return { allPrincipleResults, gaps, attentions, strengths, notAssessed, gapEvidence, attentionEvidence, strengthEvidence, controlsMap };
  }, [report, engineState]);
}
