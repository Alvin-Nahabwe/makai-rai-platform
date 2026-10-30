/**
 * The question-set proposal format, as a local copy until this branch rebases onto
 * `unit/k0b-1`, which creates `types/content.ts` (contract `00-contract.md` types/content.ts,
 * gap G076). At that rebase this file becomes
 *
 *   export type { QuestionSetProposal, RevisionAction, NewQuestion, SurvivorMapping, FieldRepoint } from '@/types/content';
 *
 * and the four supporting types below (`Stage`, `DocumentType`, `QuestionType`, `OptionMapping`)
 * are imported from the same place by the scripts that use them. Never keep both copies.
 */

export type Stage = 'pre-processing' | 'in-processing' | 'post-processing';
export type DocumentType = 'data_card' | 'model_card' | 'mitigation_plan';
/** 'likert-5' stays the type name of a practice question in 5.0.0 ("type unchanged", SRS line 3908). */
export type QuestionType = 'likert-5' | 'checklist' | 'gate';
export interface OptionMapping {
  area: string;
  role?: 'primary' | 'supporting' | 'supplementary';
}

// ---- the proposal file format: the text of 00-contract.md "types/content.ts (K0b-1)" ----

export type RevisionAction =
  | { action: 'keep'; id: string; originalText: string; reason: string }
  | { action: 'reword'; id: string; originalText: string; text: string; reason: string }
  | { action: 'merge'; id: string; originalText: string; into: string; reason: string }
  | { action: 'cut'; id: string; originalText: string; reason: string }
  | { action: 'replace'; id: string; originalText: string; newId: string; reason: string };

export interface NewQuestion {
  id: string;
  stage: Stage;
  moduleId: string;
  type: QuestionType;
  text: string;
  principle: string;
  options?: string[];
  gaps: string[];
  optionGapMap?: Record<string, Array<string | OptionMapping>>;
}

export interface SurvivorMapping {
  id: string;
  gaps: string[];
  optionGapMap?: Record<string, Array<string | OptionMapping>>;
}

export interface FieldRepoint {
  documentType: DocumentType;
  fieldId: string;
  from: string;
  to: string | 'typed_only';
}

export interface QuestionSetProposal {
  base: { commit: 'd13be0c'; file: 'data/questionBank.json'; sha256: string };
  status: 'draft' | 'checked' | 'revised' | 'approved';
  /** Exactly one per v0.5.0 id. */
  actions: RevisionAction[];
  /** One per replace. */
  newQuestions: NewQuestion[];
  /** One per id that absorbs a merge: the union mapping (SRS line 3908). */
  survivors: SurvivorMapping[];
  decisions: { 'OD-08': string; 'OD-09': string; 'OD-C3': string };
  repoints: FieldRepoint[];
  disputed: Array<{ id: string; proposer: string; checker: string }>;
}
