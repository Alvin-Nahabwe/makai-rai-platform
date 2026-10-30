import type { ChangedSinceSeal } from '@/types/api';
import type { ReactElement } from 'react';

export type StageSealBannerProps = { changed: ChangedSinceSeal | null; reviewHref: string | null };

/**
 * The "changed since seal N" banner of a stage. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, REV-b fills it.
 */
// SLOT_STUB: REV-b
export function StageSealBanner(_props: StageSealBannerProps): ReactElement | null {
  return null;
}
