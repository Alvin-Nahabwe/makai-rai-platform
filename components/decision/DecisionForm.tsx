import type { QuestionPanelData } from '@/lib/question/panel';
import type { ReactElement } from 'react';

export type DecisionFormProps = { data: QuestionPanelData };

/**
 * The answer form of S-12 ("Record a decision"). A slot of its screen (contract "Screens and slots"): the screen's owner renders it, DEC-b fills it.
 */
// SLOT_STUB: DEC-b
export function DecisionForm(_props: DecisionFormProps): ReactElement | null {
  return null;
}
