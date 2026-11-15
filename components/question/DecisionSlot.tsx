import type { ReactElement } from 'react';
import type { QuestionPanelData } from '@/lib/question/panel';
import { DecisionCard } from '@/components/decision/DecisionCard';

/**
 * What the decision card is given (coordinator's ruling of 15 November 2026, lane 2 accepted at 10:00): EXACTLY the props
 * of lane 2's `DecisionCard` in components/decision/DecisionCard.tsx. `next` is the next question that applies (the
 * panel's `position.nextId`), with its running words, its address, its 1-based place in the stage counted as
 * `position.index` counts (every question of the stage, switched off or not) and the stage's total; null on the last.
 */
export type DecisionSlotProps = {
  data: QuestionPanelData;
  next: { questionId: string; text: string; href: string; number: number; total: number } | null;
  stageHref: string;
  openFindingsOnQuestion: number;
};

/**
 * The seam between the question page's frame (lane 1) and the decision card (lane 2). The page renders the decision
 * through this slot and nothing else, so the frame never holds the decision's own parts.
 *
 * Lane 2's card renders the whole decision for a person who may record (the saved mark, the fields, evidence, the
 * consequence, Save with the way on, the finding links, More actions) and nothing for a reader, who gets the reading view.
 */
export function DecisionSlot(props: DecisionSlotProps): ReactElement | null {
  return <DecisionCard {...props} />;
}
