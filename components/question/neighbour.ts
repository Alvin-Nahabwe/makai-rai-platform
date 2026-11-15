import { questionsInStage, runningContent } from '@/lib/content/loader';
import type { QuestionPanelData } from '@/lib/question/panel';
import { questionHref } from '@/lib/question/draft';

/** A neighbouring question as the frame and the decision card name it: its id, running words, address, place and the stage's size. */
export type Neighbour = { questionId: string; text: string; href: string; number: number; total: number };

/**
 * The question `id` of this panel's stage, for the position strip and the decision card's `next`. `number` is its 1-based
 * place counted the way the panel counts `position.index` (lib/question/panel.ts: every question of the stage in the
 * running content's order, switched off by the personal data answer or not), so "Question 16 of 24" on the link is the
 * same number that question's own page shows; `total` is the panel's `position.total`. The panel took the id from this
 * same running content, so an id it lacks is a defect, not a question to skip: it throws naming it.
 */
export function neighbourOf(data: Pick<QuestionPanelData, 'orgSlug' | 'projectId' | 'stage' | 'position'>, id: string): Neighbour {
  const running = runningContent();
  const question = running.questions.get(id);
  const at = questionsInStage(running, data.stage).findIndex((q) => q.id === id);
  if (question === undefined || at < 0) throw new Error(`neighbourOf: the neighbouring question ${id} is not in the running content's ${data.stage}`);
  return { questionId: id, text: question.text, href: questionHref(data, id), number: at + 1, total: data.position.total };
}
