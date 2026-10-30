import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';

export type SealMarkerProps = { seals: SealRef[] };

/**
 * The marker "In seal N of <review>" (UX-31). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, REV-b fills it.
 */
// SLOT_STUB: REV-b
export function SealMarker(_props: SealMarkerProps): ReactElement | null {
  return null;
}
