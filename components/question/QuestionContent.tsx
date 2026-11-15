import type { LoadedQuestion } from '@/types/content';
import type { ReactElement } from 'react';
import { QUESTION_COPY } from '@/lib/question/copy';
import './QuestionContent.css';

export type QuestionContentProps = { question: LoadedQuestion; suggestionCount: number };

/** The id of the aside's first heading, which names the aside. */
const HEADING_ID = 's12-guidance';

/**
 * The guidance of the question page (UX-08, FR-CNT-02): "What good looks like", "Why this is asked" and the principle,
 * as the page's `<aside>` (plan 1C decision C1, cut to slice 1), named by its first heading. `suggestionCount` is the
 * total of SUG's `controlsForQuestion`, for the in-page link "Ways teams address this (n)". A slot of its screen
 * (contract "Screens and slots"): the screen's owner renders it, CNT fills it.
 *
 * A server component (UX-36): all of it is in the page's HTML before any script runs, and every content text is a
 * React child, so it is escaped as text. The question's text is the page's `h1` and its id and module the code line
 * under it, so neither is repeated here; the headings are `h2`, one level below that `h1`. The link down to the
 * page's `suggestions` section comes last and shows only while the guidance is not beside the form (workspace.css):
 * on a wide window the suggestions are in the same column, just below.
 */
export function QuestionContent({ question, suggestionCount }: QuestionContentProps): ReactElement {
  return (
    <aside className="question-content" data-region="guidance" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID}>{QUESTION_COPY.content.goodPractice}</h2>
      <p className="question-content__body">{question.expectedPractice}</p>
      <h2>{QUESTION_COPY.content.whyAsked}</h2>
      <p className="question-content__body">{question.whyAsked}</p>
      <p className="question-content__principle">{QUESTION_COPY.content.principle(question.principle)}</p>
      {suggestionCount > 0 ? (
        <p className="question-content__jump-line">
          <a className="question-content__jump" href="#suggestions">{QUESTION_COPY.content.jump(suggestionCount)}</a>
        </p>
      ) : null}
    </aside>
  );
}
