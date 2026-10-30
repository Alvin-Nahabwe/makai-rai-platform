import type { ReactElement } from 'react';

export type SealCheckButtonProps = { orgSlug: string; projectId: string; reviewId: string; sealId: string };

/**
 * The button that checks one seal (UX-19, M-29). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, REV-a fills it.
 */
// SLOT_STUB: REV-a
export function SealCheckButton(_props: SealCheckButtonProps): ReactElement | null {
  return null;
}
