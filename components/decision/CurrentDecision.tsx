import type { DecisionVersionView } from '@/types/api';
import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';

export type CurrentDecisionProps = { current: DecisionVersionView | null; historyCount: number; historyHref: string; seals: SealRef[] };

/**
 * The current decision of the question (S-12). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, DEC-b fills it.
 */
// SLOT_STUB: DEC-b
export function CurrentDecision(_props: CurrentDecisionProps): ReactElement | null {
  return null;
}
