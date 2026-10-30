import type { Stage } from '@/types/record';
import type { FollowUpItem } from '@/types/api';
import type { ReactElement } from 'react';

export type StageFollowUpProps = { orgSlug: string; projectId: string; stage: Stage; items: FollowUpItem[]; cannotAct: FollowUpItem[] };

/**
 * The follow-up of one stage on the project page. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, FUP fills it.
 */
// SLOT_STUB: FUP
export function StageFollowUp(_props: StageFollowUpProps): ReactElement | null {
  return null;
}
