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
export function canGenerateReport(state: EngineState): boolean;
export function calculateAreaScores(state: EngineState, stage: string): AreaScoreMap;
export function calculatePrincipleScores(state: EngineState, stage: string): PrincipleScoreMap;
export function getModifiedWeights(state: EngineState, stage: string): Record<string, WeightModifier>;
export function getWeightExplanations(state: EngineState, stage: string): WeightExplanation[];
export function getUnlockedConditionalQuestions(state: EngineState, stage: string): string[];
export function getVisibleQuestions(state: EngineState, stage: string): Question[];
export function generateReportData(state: EngineState): ReportData;
