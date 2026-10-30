import type { Stage } from '@/types/record';
import type { StageReviewView } from '@/types/api';
import type { ReactElement } from 'react';

export type StageReviewsSummaryProps = { orgSlug: string; projectId: string; stage: Stage; reviews: StageReviewView[]; canOpen: boolean };

/**
 * The stage reviews of one stage on the project page. `canOpen` is `can(role, 'review:open') && !archived`. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, REV-b fills it.
 */
// SLOT_STUB: REV-b
export function StageReviewsSummary(_props: StageReviewsSummaryProps): ReactElement | null {
  return null;
}
