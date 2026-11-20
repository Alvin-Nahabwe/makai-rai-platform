import type { StageCounts } from '@/types/api';

/**
 * The "N of M" of a stage's bar (G4). M (`recordable`) leaves out the questions the sensitive-data gate removed; N
 * (`recorded`) is M less the questions with no decision. Both come from the existing counts, so a finished stage reads
 * recorded === recordable. Pure.
 */
export function stageProgress(c: StageCounts): { recordable: number; recorded: number } {
  const recordable = c.questions - c.notApplicableByGate;
  return { recordable, recorded: recordable - c.noDecision };
}
