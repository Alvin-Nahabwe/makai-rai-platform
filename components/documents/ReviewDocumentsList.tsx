import type { IssuedDocumentView } from '@/types/api';
import type { ReactElement } from 'react';

export type ReviewDocumentsListProps = { orgSlug: string; projectId: string; reviewId: string; documents: IssuedDocumentView[] };

/**
 * The documents issued from one stage review. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, DOC-a fills it.
 */
// SLOT_STUB: DOC-a
export function ReviewDocumentsList(_props: ReviewDocumentsListProps): ReactElement | null {
  return null;
}
