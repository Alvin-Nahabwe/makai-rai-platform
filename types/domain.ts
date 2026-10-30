/**
 * Shared domain types for the question bank and the framework data.
 *
 * These describe the shapes of the JSON data files (`data/questionBank.json`,
 * `data/assessmentAreas.json`). They replace the scattered `any` annotations
 * that previously wrapped this data.
 */

/**
 * A single answer:
 * - Likert index (0-4) → number
 * - Gate (Yes/No) → the selected option label (string)
 * - Checklist → the selected option labels (string[])
 */
export type ResponseValue = number | string | string[];

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
