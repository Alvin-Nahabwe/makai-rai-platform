import { TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import type { DecisionStatus, Stage } from '@/types/record';

/** Each stage's vocabulary entry: a stage's name is defined where it first appears on a screen (owner decision D1, spec 6). */
export const STAGE_TERMS: Readonly<Record<Stage, DefinedEntry>> = Object.freeze({
  'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3,
});

/** Each decision status's vocabulary entry: the status words are terms, defined where a screen first uses them (spec 6). */
export const STATUS_TERMS: Readonly<Record<DecisionStatus, DefinedEntry>> = Object.freeze({
  done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE,
});
