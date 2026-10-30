import type { IssuedDocumentView } from '@/types/api';
import type { ReactElement } from 'react';

export type DocumentActionsProps = { orgSlug: string; document: IssuedDocumentView; canWithdraw: boolean };

/**
 * "Copy as text" and "Withdraw" for one issued document (M-36). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, DOC-b fills it.
 */
// SLOT_STUB: DOC-b
export function DocumentActions(_props: DocumentActionsProps): ReactElement | null {
  return null;
}
