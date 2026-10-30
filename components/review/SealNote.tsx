import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';

export type SealNoteProps = { seals: SealRef[]; nextVersionNumber: number };

/**
 * What saving will do to a decision that is in a seal (W-3 note 4, UX-31). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, REV-b fills it.
 */
// SLOT_STUB: REV-b
export function SealNote(_props: SealNoteProps): ReactElement | null {
  return null;
}
