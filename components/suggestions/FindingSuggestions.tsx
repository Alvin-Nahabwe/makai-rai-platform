import type { ReactElement } from 'react';

export type FindingSuggestionsProps = { contentSemver: string; riskArea: string | null };

/**
 * The controls suggested for a finding's risk area (FR-SUG-03). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, SUG fills it.
 */
// SLOT_STUB: SUG
export function FindingSuggestions(_props: FindingSuggestionsProps): ReactElement | null {
  return null;
}
