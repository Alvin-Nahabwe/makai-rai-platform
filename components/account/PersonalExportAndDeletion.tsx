import type { ReactElement } from 'react';
import { PersonalExportAndDeletionForm } from './PersonalExportAndDeletionForm';

export type PersonalExportAndDeletionProps = { lastActiveOwnerOf: string[] };

/**
 * S-21's "My data" and "Delete my account" regions (W-12 notes 4 and 5; FR-EXP-02, FR-EXP-03). A slot of
 * its screen (contract "Screens and slots"): ACC-b's account page renders it with `lastActiveOwnerOf`
 * (ACC-b's read), and this unit fills it.
 */
export function PersonalExportAndDeletion({ lastActiveOwnerOf }: PersonalExportAndDeletionProps): ReactElement {
  return <PersonalExportAndDeletionForm lastActiveOwnerOf={lastActiveOwnerOf} />;
}
