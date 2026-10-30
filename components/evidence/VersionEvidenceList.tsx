import type { EvidenceItemView } from '@/types/api';
import type { ReactElement } from 'react';

export type VersionEvidenceListProps = { orgSlug: string; items: EvidenceItemView[] };

/**
 * The evidence of one decision version, with the erased label (FR-EVD-05). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, EVD fills it.
 */
// SLOT_STUB: EVD
export function VersionEvidenceList(_props: VersionEvidenceListProps): ReactElement | null {
  return null;
}
