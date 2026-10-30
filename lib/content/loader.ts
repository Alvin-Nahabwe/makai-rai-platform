/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { ContentSemver, LoadedContent, LoadedQuestion, ReasonCodeEntry } from '@/types/content';
import type { ScopeAnswer, Stage } from '@/types/record';
import { NotImplementedError } from '@/lib/http/errors';

/**
 * Load a content version and look up its questions, areas, controls and reason codes (FR-CNT-01 to 04, 06, 07).
 * Typed stubs that throw until the producer merges: a caller that starts earlier orders its tasks so no test
 * reaches them (contract, "Content stubs before CNT merges").
 */

// CONTRACT_STUB: CNT
export function loadContent(semver: ContentSemver): LoadedContent {
  throw new NotImplementedError('CNT');
}

// CONTRACT_STUB: CNT
export function runningContent(): LoadedContent {
  throw new NotImplementedError('CNT');
}

// CONTRACT_STUB: CNT
export function questionsInStage(c: LoadedContent, stage: Stage): LoadedQuestion[] {
  throw new NotImplementedError('CNT');
}

// CONTRACT_STUB: CNT
export function reasonCodesFor(c: LoadedContent, status: 'not_applicable' | 'not_yet'): ReasonCodeEntry[] {
  throw new NotImplementedError('CNT');
}

/**
 * FR-CNT-04: a question with a `condition` on the gate applies when the gate's current scope answer is
 * `'yes'` or `'not_sure'`, and also while the gate has no answer (`null`).
 */
// CONTRACT_STUB: CNT
export function questionApplies(c: LoadedContent, questionId: string, gate: ScopeAnswer | null): boolean {
  throw new NotImplementedError('CNT');
}
