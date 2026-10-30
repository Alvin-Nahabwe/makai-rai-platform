import type { Stage } from '@/types/record';
import type { ReactElement } from 'react';

export type StageFollowUpCountsProps = { orgSlug: string; projectId: string; stage: Stage; counts: { openFindings: number; overdueMitigations: number } };

/**
 * The open-finding and overdue-mitigation counts on the stage page. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, FUP fills it.
 */
// SLOT_STUB: FUP
export function StageFollowUpCounts(_props: StageFollowUpCountsProps): ReactElement | null {
  return null;
}
