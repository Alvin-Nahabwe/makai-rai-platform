/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { ContentArea, ContentControl, LoadedContent } from '@/types/content';
import type { Stage } from '@/types/record';

/** Controls for a question or risk area (FR-SUG-01 to 03, UX-13). Typed stubs until the producer merges; the lists are empty. */

export type ControlGroup = {
  area: ContentArea;
  controls: Array<{ control: ContentControl; alsoAddresses: string[]; usuallyAppliedIn: Stage | null }>;
};

// CONTRACT_STUB: SUG
export function controlsForQuestion(
  c: LoadedContent, questionId: string, tickedOptions: readonly string[],
): { first: ControlGroup[]; rest: ControlGroup[] } {
  return { first: [], rest: [] };
}

// CONTRACT_STUB: SUG
export function controlsForArea(c: LoadedContent, areaId: string): ControlGroup[] {
  return [];
}
