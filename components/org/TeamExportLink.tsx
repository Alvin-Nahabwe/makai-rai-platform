import type { ReactElement } from 'react';

export type TeamExportLinkProps = { orgSlug: string; canExport: boolean };

/**
 * The link to the team export on the organisation settings page. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, EXP fills it.
 */
// SLOT_STUB: EXP
export function TeamExportLink(_props: TeamExportLinkProps): ReactElement | null {
  return null;
}
