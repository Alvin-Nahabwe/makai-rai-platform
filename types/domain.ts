/**
 * Shared domain types for the assessment engine, question bank, and report data.
 *
 * These describe the shapes produced by `lib/engine/AssessmentEngine.js` and the
 * JSON data files (`data/questionBank.json`, `data/assessmentAreas.json`). They
 * replace the scattered `any` annotations that previously wrapped this data.
 */

/**
 * A single answer:
 * - Likert index (0-4) → number
 * - Gate (Yes/No) → the selected option label (string)
 * - Checklist → the selected option labels (string[])
 */
export type ResponseValue = number | string | string[];

export type StageStatus = 'locked' | 'available' | 'completed';

export interface StageState {
  status: StageStatus;
  responses: Record<string, ResponseValue>;
  completedAt: string | null;
}

export interface EngineState {
  version: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<string, StageState>;
}

export type QuestionType = 'likert-5' | 'checklist' | 'gate';

export interface QuestionCondition {
  questionId: string;
  value?: number;
  minValue?: number;
}

export interface OptionMapping {
  area: string;
  role?: 'primary' | 'supporting' | 'supplementary';
}

/** Maps each checklist option label to the areas (and roles) it provides evidence for. */
export type OptionGapMap = Record<string, Array<string | OptionMapping>>;

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  scale?: string[];
  options?: string[];
  principle?: string;
  gaps?: string[];
  weight?: number;
  helpText?: string;
  example?: string;
  condition?: QuestionCondition;
  /** Present on cross-stage conditional questions; truthy means "conditionally unlocked". */
  crossStageCondition?: { questionId?: string; label?: string; value?: number; minValue?: number };
  optionGapMap?: OptionGapMap;
}

export interface QuestionModule {
  id: string;
  title: string;
  description?: string;
  questions: Question[];
}

export interface QuestionStage {
  modules: QuestionModule[];
}

export interface QuestionBank {
  stages: Record<string, QuestionStage>;
}

export interface Reference {
  citation: string;
  doi?: string;
  url?: string;
  relevance?: string;
}

export interface ResourceLink {
  title: string;
  url: string;
  type?: string;
}

export interface Control {
  id: string;
  name: string;
  type: string;
  description: string;
  notebook?: string | null;
  template?: string | null;
  resources?: ResourceLink[];
}

export interface AssessmentArea {
  id: string;
  name: string;
  stage: string;
  principle: string;
  description: string;
  context?: string;
  introduced?: string;
  exposed?: string;
  mitigated?: string;
  controls?: string[];
  references?: Reference[];
}

export interface AssessmentAreasData {
  meta?: Record<string, unknown>;
  stages?: Record<string, unknown>;
  areas: AssessmentArea[];
  controls: Control[];
}

/** Area id -> 0-100 score. */
export type AreaScoreMap = Record<string, number>;
/** Principle label -> 0-100 score. */
export type PrincipleScoreMap = Record<string, number>;

export interface WeightModifier {
  modifier: number;
  rules: string[];
}

export interface WeightExplanationSource {
  type?: 'area' | 'question';
  areaId?: string;
  areaName?: string;
  areaScore?: number;
  questionId?: string;
  questionText?: string;
  questionScore?: ResponseValue;
  threshold?: number;
}

export interface WeightExplanation {
  questionId: string;
  questionText: string;
  modifier: number;
  ruleId: string;
  rationale: string;
  citation?: string;
  source: WeightExplanationSource;
  stage?: string;
}

export interface UnlockedConditional {
  stage: string;
  questionIds: string[];
}

export interface ReportData {
  version: string;
  generatedAt: string;
  completedStages: string[];
  overallScore: number;
  stageScores: Record<string, AreaScoreMap>;
  principleScores: Record<string, PrincipleScoreMap>;
  activeModifiers: WeightExplanation[];
  unlockedConditionals: UnlockedConditional[];
}
