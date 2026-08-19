'use client';

import { useMemo } from 'react';
import assessmentAreasRaw from '@/data/assessmentAreas.json';
import { ratingLabels } from '@/data/constants';
import { getResponses, getScoringQuestions } from '@/lib/engine/AssessmentEngine.js';
import type {
  AssessmentAreasData,
  AssessmentArea,
  Control,
  Question,
  OptionMapping,
  EngineState,
  PracticeCoverage,
  ReportData,
  ResponseValue,
} from '@/types/domain';

const assessmentAreas = assessmentAreasRaw as unknown as AssessmentAreasData;

/**
 * A finding produced by the hook -- which question scored low (or high) and
 * why. Renamed from `EvidenceItem` (Plan 1c Task 9): this is NOT evidence in
 * the sense the rest of this phase introduces (an uploaded artifact backing
 * a claim, `prisma/schema.prisma`'s `Evidence` model). Shipping both
 * meanings of the word into one report is a defect in a document read by
 * auditors who have a fixed definition of "evidence" -- see
 * docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md
 * §4.3. From this phase on, "evidence" means artifacts; this is a finding.
 */
export interface FindingItem {
  questionId: string;
  questionText: string;
  stage: string;
  reason: string;
  detail?: string;
  tier: 'gap' | 'attention' | 'strength';
}

/**
 * One checklist option's evidence for a single area -- the per-item detail
 * behind `PracticeCoverage`'s bare counts (Task 5b; approved spec §3.3:
 * practices render "with the ticked and unticked items enumerable beneath
 * it and each item's role shown"). `PracticeCoverage` itself only carries
 * counts, not identities, so this is built in the SAME `optionGapMap` walk
 * that produces `gapEvidence`/`attentionEvidence`/`strengthEvidence` below
 * (one push per (question, option→area mapping), unconditionally, where
 * that walk pushes conditionally per tier) -- the identical loop
 * `AssessmentEngine.calculateAreaScores`'s "Source 2" already counts by, so
 * an area's itemised list and its `PracticeCoverage.total` are provably the
 * same count rather than two independent derivations that could drift.
 * `checked` is deliberately not named `inPlace`/`gap`/anything evaluative --
 * an unticked item is a practice not yet in place, not a wrong answer.
 */
export interface PracticeItem {
  label: string;
  role: 'primary' | 'supporting' | 'supplementary';
  checked: boolean;
  questionId: string;
  stage: string;
}

/** A question annotated with the user's response, used in principle results. */
type PrincipleQuestion = Question & { response?: ResponseValue; normalized: number };

/** Principle result for a single principle in a stage. */
export interface PrincipleResult {
  name: string;
  // `null` when the principle's EvidenceScore.maturity is null -- no
  // question ever reached this principle in this stage. See getLevel.
  pct: number | null;
  level: string;
  // The same principle's checklist coverage, carried alongside `pct` rather
  // than dropped: `EvidenceScore` has two independent readings (Task 1) and
  // PrincipleScorecard renders both (Task 5). `null` means no checklist
  // question maps an option to this principle -- 14 of 19 stage x principle
  // cells, per the Task 2 controller measurement.
  practices: PracticeCoverage | null;
  questions: PrincipleQuestion[];
}

/** Return type of the useFindingsData hook. */
export interface FindingsData {
  allPrincipleResults: Record<string, PrincipleResult[]>;
  gaps: AssessmentArea[];
  attentions: AssessmentArea[];
  strengths: AssessmentArea[];
  notAssessed: AssessmentArea[];
  gapEvidence: Record<string, FindingItem[]>;
  attentionEvidence: Record<string, FindingItem[]>;
  strengthEvidence: Record<string, FindingItem[]>;
  controlsMap: Record<string, Control>;
  /** areaId → the individual checklist items behind that area's PracticeCoverage. */
  practiceItems: Record<string, PracticeItem[]>;
}

/**
 * Derives the maturity level from a percentage score.
 * Kept here because the hook needs it for principle results.
 * Also re-exported so ReportPage can use it for overallLevel.
 */
// Returns a maturity key matching data/constants levelLabels/levelColors/
// levelDescriptions ('strong' | 'developing' | 'needsWork' | 'critical' |
// 'notAssessed'). (Higher score = higher maturity = lower risk.)
export function getLevel(pct: number | null): string {
  // `null` means the framework never asked a question that reaches this
  // area/principle -- not the same as a real answer scoring zero. The
  // null check MUST come first: `null >= 75` is `false`, so without this
  // guard a never-asked area falls through every branch below and lands
  // in 'critical', the worst band, silently.
  if (pct === null) return 'notAssessed';
  if (pct >= 75) return 'strong';
  if (pct >= 50) return 'developing';
  if (pct >= 25) return 'needsWork';
  return 'critical';
}

/**
 * The findings computation itself, factored out of the `useMemo` body so it
 * is callable -- and testable -- without a React render pass. This repo has
 * no jsdom/@testing-library/react (D-169; see __tests__/helpers/
 * extractText.ts), so a hook that only ever ran inside `useMemo` could not
 * be exercised directly: React throws "Invalid hook call" for any hook
 * invoked outside a component render. `useFindingsData` below is now a thin
 * memoizing wrapper around this plain function, the same split
 * `getLevel`/`formatProvenanceLine`/`questionExistsInBank` already use --
 * pure logic extracted so tests can fabricate a `ReportData` and call it
 * directly, per __tests__/unit/findings-data.test.ts.
 */
export function computeFindingsData(
  report: ReportData | null,
  engineState: EngineState | null,
): FindingsData {
  if (!report || !engineState || report.completedStages.length === 0) {
    return { allPrincipleResults: {}, gaps: [], attentions: [], strengths: [], notAssessed: [], gapEvidence: {}, attentionEvidence: {}, strengthEvidence: {}, controlsMap: {}, practiceItems: {} };
  }

    /**
     * Questions that count for a stage.
     *
     * ENG-03 prerequisite P-b: this used to be a second, independent
     * implementation of question selection, and it disagreed with the
     * engine's in a way that mattered — it never enforced `q.condition`, the
     * intra-stage gate. That is reachable: answer the gate Yes, answer its
     * dependent question badly, then set the gate to No. The response stays in
     * storage, so this layer kept treating it as evidence while the score
     * dropped it, and an area could be rendered as a primary gap while scoring
     * 100. It now defers to the engine's single selection rule.
     */
    function getStageQuestionsWithConditionals(stage: string): Question[] {
      return getScoringQuestions(engineState!, stage) as Question[];
    }

    const { completedStages, principleScores } = report;
    const allPrincipleResults: Record<string, PrincipleResult[]> = {};
  completedStages.forEach((stage: string) => {
    const scores = principleScores[stage] || {};
    const responses = getResponses(engineState!, stage);
    const allQ = getStageQuestionsWithConditionals(stage);

    allPrincipleResults[stage] = Object.entries(scores).map(([name, score]) => {
      const questions: PrincipleQuestion[] = allQ.filter((q) => q.principle === name).map((q) => {
        const r = responses[q.id];
        return {
          ...q, response: r,
          normalized: q.type === 'likert-5' && typeof r === 'number' ? r / 4 : 0,
        };
      });
      // Read .maturity, not the EvidenceScore wrapper -- passing the wrapper
      // itself to getLevel would compare an object to 75/50/25 (always
      // false) and silently misclassify every principle as 'critical'.
      const pct = score.maturity;
      return { name, pct, level: getLevel(pct), practices: score.practices, questions };
    }).sort((a, b) => {
      // Ascending by score so the weakest principle surfaces first -- but a
      // null (never asked) is not a zero. Coercing null to 0 here (e.g.
      // `a.pct - b.pct` with JS's null->0 arithmetic coercion) would sort a
      // never-asked principle alongside or ahead of a real 0%, the same
      // silent-worst-band bug getLevel's null guard exists to prevent. Nulls
      // sort last instead: not a concern to prioritise, not a strength either.
      const aPct = a.pct ?? Infinity;
      const bPct = b.pct ?? Infinity;
      return aPct - bPct;
    });
  });

  // Aggregate gap evidence across all completed stages — THREE-TIER system
  // Based on ISO 33020 (Process Measurement Framework) thresholds:
  //   0-1: Gap (Not achieved / lower Partially achieved)
  //   2:   Attention needed (P/L boundary)
  //   3-4: Adequate (Largely / Fully achieved)
  const gapEvidence: Record<string, FindingItem[]> = {};      // areaId → [{questionId, reason, detail, ...}]
  const attentionEvidence: Record<string, FindingItem[]> = {}; // areaId → [{questionId, reason, detail, ...}]
  const controlsMap: Record<string, Control> = {};
  assessmentAreas.controls.forEach((c) => { controlsMap[c.id] = c; });

  const strengthEvidence: Record<string, FindingItem[]> = {};
  // areaId → every checklist option that maps to it, ticked or not -- built
  // unconditionally in the same walk below, so it can never disagree with
  // the counts that walk feeds into gap/attention/strengthEvidence.
  const practiceItems: Record<string, PracticeItem[]> = {};

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

            // Item-level detail (Task 5b): one push per mapping, regardless
            // of role or checked state -- the tier branches below decide
            // whether a mapping produces a *finding*, this records that the
            // practice exists at all, which every mapping does.
            //
            // EXCEPT when this checklist question was never answered at
            // all (`resp === undefined`, checked outside this loop, fixed
            // per question). `calculateAreaScores`'s Source 2
            // (lib/engine/AssessmentEngine.js) has its own guard --
            // `if (qResponses[q.id] === undefined) continue;`, "unanswered
            // contributes nothing" -- that this loop must mirror, or an
            // unlocked-but-unanswered cross-stage-conditional checklist
            // question (a pattern the engine already supports for
            // likert-5; no shipped checklist carries one today, but
            // nothing prevents a future content update from adding one)
            // would silently add unticked items to the list while
            // PracticeCoverage's own count stayed unchanged -- the "count
            // says 7 of 12, list shows 9" failure the brief calls worse
            // than no list at all (fix round 1, Finding 1).
            if (resp !== undefined) {
              if (!practiceItems[areaId]) practiceItems[areaId] = [];
              practiceItems[areaId].push({
                label: opt,
                role: role ?? 'supporting',
                checked: wasChecked,
                questionId: q.id,
                stage,
              });
            }

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

  // Area tier classification reads per-question evidence (built above from
  // raw responses), never a stageScores/AreaScoreMap number -- so there is
  // no numeric-vs-.maturity distinction to make here. An area with no
  // question ever reaching it produces no entry in ANY of gapEvidence/
  // attentionEvidence/strengthEvidence, so it already falls through to
  // notAssessed by construction. That is the same outcome the maturity
  // split gives areas whose EvidenceScore.maturity is null -- both mean
  // "nothing to answer" -- so no additional null-routing is needed here.
  const gaps = assessmentAreas.areas.filter((a) => gapEvidence[a.id]);
  const attentions = assessmentAreas.areas.filter((a) => attentionEvidence[a.id] && !gapEvidence[a.id]);
  const gapIds = new Set(gaps.map((a) => a.id));
  const attentionIds = new Set(attentions.map((a) => a.id));
  const strengths = assessmentAreas.areas.filter((a) => !gapIds.has(a.id) && !attentionIds.has(a.id) && strengthEvidence[a.id]?.length > 0);
  const notAssessed = assessmentAreas.areas.filter((a) => !gapIds.has(a.id) && !attentionIds.has(a.id) && !strengthEvidence[a.id]?.length);

  return { allPrincipleResults, gaps, attentions, strengths, notAssessed, gapEvidence, attentionEvidence, strengthEvidence, controlsMap, practiceItems };
}

/**
 * Custom hook that memoizes the full findings computation for the report --
 * which questions scored low and why. Renamed from `useEvidenceData` (Plan
 * 1c Task 9); see `FindingItem`'s doc comment above for why.
 */
export function useFindingsData(
  report: ReportData | null,
  engineState: EngineState | null,
): FindingsData {
  return useMemo(() => computeFindingsData(report, engineState), [report, engineState]);
}
