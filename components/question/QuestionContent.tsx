import type { LoadedQuestion } from '@/types/content';
import type { ReactElement } from 'react';

export type QuestionContentProps = { question: LoadedQuestion; suggestionCount: number };

/**
 * The question text, principle, "What good looks like" and "Why this is asked" (UX-08, FR-CNT-02). `suggestionCount` is the total of SUG's `controlsForQuestion`, for the in-page link "Ways teams address this (n)". A slot of its screen (contract "Screens and slots"): the screen's owner renders it, CNT fills it.
 */
// SLOT_STUB: CNT
export function QuestionContent(_props: QuestionContentProps): ReactElement | null {
  return null;
}
