import type { Stage } from '@/types/record';
import type { ReactElement } from 'react';

export type QuestionFindingLinkProps = { orgSlug: string; projectId: string; stage: Stage; questionId: string; currentVersionId: string | null; openFinding: { findingId: string } | null; canRaise: boolean };

/**
 * The link to the open finding of the question, or to raise one (UX-14, FR-FND-02). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, FND-b fills it.
 */
// SLOT_STUB: FND-b
export function QuestionFindingLink(_props: QuestionFindingLinkProps): ReactElement | null {
  return null;
}
