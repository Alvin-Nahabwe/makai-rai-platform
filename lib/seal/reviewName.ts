import type { Stage } from '@/types/record';

/**
 * The name the platform gives a stage review (FR-REV-01; contract "Further cross-unit symbols", gap G016):
 * the stage value with its first letter upper-cased, then " review <n>", as "In-processing review 1". The
 * one place this text is made, so S-16, the documents and the export name a review alike.
 */
export function stageReviewName(stage: Stage, numberInStage: number): string {
  if (!Number.isInteger(numberInStage) || numberInStage < 1) {
    throw new TypeError(`stageReviewName: ${numberInStage} is not a review number`);
  }
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)} review ${numberInStage}`;
}
