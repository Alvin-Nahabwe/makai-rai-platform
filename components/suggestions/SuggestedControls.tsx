import type { ReactElement } from 'react';

export type SuggestedControlsProps = { contentSemver: string; questionId: string; tickedOptions: readonly string[] };

/**
 * "Ways teams address this" on S-12 (UX-13). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, SUG fills it.
 */
// SLOT_STUB: SUG
export function SuggestedControls(_props: SuggestedControlsProps): ReactElement | null {
  return null;
}
