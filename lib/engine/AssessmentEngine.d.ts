/**
 * Type declarations for the plain-JS assessment engine (AssessmentEngine.js).
 * Keeps the engine authored in JS (so it can be shared/tested without a build
 * step) while giving every consumer real types instead of `any`.
 */
import type {
  EngineState,
  ResponseValue,
  AreaScoreMap,
  PrincipleScoreMap,
  EvidenceScore,
  WeightModifier,
  WeightExplanation,
  Question,
  ReportData,
} from '@/types/domain';

export function createAssessment(): EngineState;
export function getResponses(state: EngineState, stage: string): Record<string, ResponseValue>;
export function setResponse(
  state: EngineState,
  stage: string,
  questionId: string,
  value: ResponseValue,
): EngineState;
export function getStageStatus(state: EngineState, stage: string): string;
export function saveState(state: EngineState): void;
export function loadState(): EngineState | null;
export function clearState(): void;
export function resetAssessment(): EngineState;
export function completeStage(
  state: EngineState,
  stage: string,
  options?: { skipValidation?: boolean },
): EngineState;
export function isStageAccessible(state: EngineState, stage: string): boolean;
export function getNextStage(state: EngineState): string | null;
/**
 * Structural precondition of every stage-indexing function in the engine.
 * Takes `unknown` deliberately: its callers are the ones holding a value
 * that has NOT been proven to be an `EngineState` yet -- a JSON request
 * body, or a `Prisma.JsonValue` read back from the database.
 */
export function hasWellFormedStages(state: unknown): boolean;
export function canGenerateReport(state: EngineState): boolean;
export function calculateAreaScores(state: EngineState, stage: string): AreaScoreMap;
export function calculatePrincipleScores(state: EngineState, stage: string): PrincipleScoreMap;
export function getModifiedWeights(state: EngineState, stage: string): Record<string, WeightModifier>;
export function getWeightExplanations(state: EngineState, stage: string): WeightExplanation[];
export function getUnlockedConditionalQuestions(state: EngineState, stage: string): string[];
export function getVisibleQuestions(state: EngineState, stage: string): Question[];
export function generateReportData(state: EngineState): ReportData;

/**
 * Mean maturity across one or more score maps (area or principle axis --
 * both are Record<string, EvidenceScore>). Nulls are excluded from each
 * map's own mean rather than counted as zero; each map then contributes an
 * equal share to the result. Returns null, not 0, when there is nothing to
 * average -- see the implementation's doc comment for the full reasoning.
 */
export function meanMaturity(scoreMaps: Array<Record<string, EvidenceScore>>): number | null;

/**
 * The scoring methodology version stamped into every generated report.
 * Bumped when a given set of answers would produce a different number.
 */
export const SCORING_VERSION: string;

/**
 * The questions that count for a stage: cross-stage conditionals excluded
 * unless unlocked, and intra-stage gate conditions enforced. The single
 * selection rule — anything re-deriving this will drift from it.
 */
export function getScoringQuestions(state: EngineState, stage: string): Question[];

/** Evidence sources for an area; see the engine for the scope parameter. */
export function evidenceSourcesForArea(
  state: EngineState,
  area: { id: string; stage: string },
  options?: { scope?: 'area-stage' | 'all-stages' },
): Array<{ question: Question; stage: string }>;
