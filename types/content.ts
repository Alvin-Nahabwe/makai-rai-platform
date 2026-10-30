import type { Stage, DocumentType } from './record';

export type ContentSemver = string;
/** 'likert-5' stays the type name of a practice question in 5.0.0 ("type unchanged", SRS line 3908). */
export type QuestionType = 'likert-5' | 'checklist' | 'gate';
export interface OptionMapping { area: string; role?: 'primary' | 'supporting' | 'supplementary' }

export interface ContentQuestion {
  id: string;
  type: QuestionType;
  text: string;
  principle: string;
  /** Checklist options; an option's id is its text, as in 4.0.0 (`data/questionBank.json`). */
  options?: string[];
  gaps: string[];
  optionGapMap?: Record<string, Array<string | OptionMapping>>;
  /** Kept only on the gate-dependent questions (SRS line 3916). */
  condition?: { questionId: string; value: string };
  helpText?: string;
  example?: string;
  expectedPractice: string;
  whyAsked: string;
  reasonPrompt: string;
  evidenceExamples: string[];
}
export interface ContentModule {
  id: string;
  title: string;
  description?: string;
  momentsOfBias?: unknown;
  questions: ContentQuestion[];
}
export interface QuestionBankFile {
  meta: { version: ContentSemver; [k: string]: unknown };
  stages: Record<Stage, { modules: ContentModule[] }>;
}
export interface ResourceLink { title: string; url: string; type?: string }
export interface ContentArea {
  id: string; name: string; stage: Stage; principle: string; description: string;
  context?: string; introduced?: string; exposed?: string; mitigated?: string;
  controls?: string[]; references?: Array<{ citation: string; doi?: string; url?: string; relevance?: string }>;
}
/** No `notebook` or `template` field: availability lives in data/resources.json (FR-CNT-05, ADR-C9). */
export interface ContentControl { id: string; name: string; type: string; description: string; resources?: ResourceLink[] }
export interface AreasFile { meta: { version: ContentSemver; [k: string]: unknown }; areas: ContentArea[]; controls: ContentControl[] }
export interface ReasonCodeEntry {
  code: `na_${string}` | `ny_${string}`;
  status: 'not_applicable' | 'not_yet';
  label: string;
  useWhen: string;
  reasonMustSay: string;
}
export interface ReasonCodesFile { codes: ReasonCodeEntry[] }
export type DocumentHelpFile = Record<DocumentType, string>;
export interface ContentIndexFile { running: ContentSemver; versions: ContentSemver[] }
export interface SignOffRecord {
  /** 'pre-processing' | 'in-processing' | 'post-processing' | 'help-and-reason-codes' | 'question-set:<stage>' */
  batch: string;
  approver: string;
  at: string;
  sha256: string;
  items: string[];
}
export interface SignOffsFile { records: SignOffRecord[] }
export interface ResourcesFile {
  /** `file`: the URL path the file is served at, `/templates/<name>.html`; on disk under `public` (gap G078). */
  templates: Array<{ controlId: string; file: string; kind: string; bytes: number; sha256: string;
    review: { reviewer: string; date: string; outcome: 'passed' | 'failed' } }>;
  /** `file` `/notebooks/<name>.ipynb`, `requirementsFile` `/notebooks/requirements.txt`; `released` only with outcome 'passed'. */
  notebooks: Array<{ controlId: string; file: string; requirementsFile: string; sha256: string; bytes: number;
    review: { reviewer: string; date: string; outcome: 'passed' | 'failed' }; released: boolean }>;
}
export interface LoadedQuestion extends ContentQuestion {
  stage: Stage;
  moduleId: string;
  moduleTitle: string;
  /** 0-based position in the stage in module order (7.1.6). */
  order: number;
}
/** The question-set proposal file `docs/content/question-set-5.0.0/proposal.json` (C-TXT writes it; CNT and C-MAP read it; gap G076). */
export type RevisionAction =
  | { action: 'keep'; id: string; originalText: string; reason: string }
  | { action: 'reword'; id: string; originalText: string; text: string; reason: string }
  | { action: 'merge'; id: string; originalText: string; into: string; reason: string }
  | { action: 'cut'; id: string; originalText: string; reason: string }
  | { action: 'replace'; id: string; originalText: string; newId: string; reason: string };
export interface NewQuestion { id: string; stage: Stage; moduleId: string; type: QuestionType; text: string; principle: string;
  options?: string[]; gaps: string[]; optionGapMap?: Record<string, Array<string | OptionMapping>> }
export interface SurvivorMapping { id: string; gaps: string[]; optionGapMap?: Record<string, Array<string | OptionMapping>> }
export interface FieldRepoint { documentType: DocumentType; fieldId: string; from: string; to: string | 'typed_only' }
export interface QuestionSetProposal {
  base: { commit: 'd13be0c'; file: 'data/questionBank.json'; sha256: string };
  status: 'draft' | 'checked' | 'revised' | 'approved';
  actions: RevisionAction[];
  newQuestions: NewQuestion[];
  survivors: SurvivorMapping[];
  decisions: { 'OD-08': string; 'OD-09': string; 'OD-C3': string };
  repoints: FieldRepoint[];
  disputed: Array<{ id: string; proposer: string; checker: string }>;
}
export interface LoadedContent {
  semver: ContentSemver;
  contentHash: string;
  questions: ReadonlyMap<string, LoadedQuestion>;
  areas: ReadonlyMap<string, ContentArea>;
  controls: ReadonlyMap<string, ContentControl>;
  reasonCodes: readonly ReasonCodeEntry[];
  documentHelp: DocumentHelpFile;
}
