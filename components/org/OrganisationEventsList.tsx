import type { OrgEventView } from '@/types/api';
import type { ReactElement } from 'react';

export type OrganisationEventsListProps = { events: OrgEventView[]; hasMore: boolean };

/**
 * The action rows of the organisation settings page. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, ORG fills it.
 */
// SLOT_STUB: ORG
export function OrganisationEventsList(_props: OrganisationEventsListProps): ReactElement | null {
  return null;
}
