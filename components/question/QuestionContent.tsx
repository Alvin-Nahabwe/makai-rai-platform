import type { LoadedQuestion } from '@/types/content';
import type { ReactElement } from 'react';
import './QuestionContent.css';

export type QuestionContentProps = { question: LoadedQuestion; suggestionCount: number };

/**
 * The question text, principle, "What good looks like" and "Why this is asked" (UX-08, FR-CNT-02). `suggestionCount` is the total of SUG's `controlsForQuestion`, for the in-page link "Ways teams address this (n)". A slot of its screen (contract "Screens and slots"): the screen's owner renders it, CNT fills it.
 *
 * A server component (UX-36): all of it is in the page's HTML before any script runs, and every content text is a
 * React child, so it is escaped as text. It renders inside the shell's `question` region, which the shell names with
 * its own `<h2 id="s12-question">`, so its headings are one level below that one. Order and copy follow W-3 (SRS lines
 * 1835-1855, and line 1942 for narrow screens): the principle, the question, then, when there
 * is something to suggest, a link down to the shell's `suggestions` section, which only narrow screens show (on wide
 * ones the suggestions sit beside the question), then the expected practice and why the question is asked. The id and
 * module title are the page's heading (`h1`), so they are not repeated here (CONSOLIDATED section 4).
 */
export function QuestionContent({ question, suggestionCount }: QuestionContentProps): ReactElement {
  return (
    <div className="question-content">
      <p className="question-content__principle">{`Principle: ${question.principle}`}</p>
      <h3 className="question-content__text">{question.text}</h3>
      {suggestionCount > 0 ? (
        <p className="question-content__jump-line">
          <a className="question-content__jump" href="#suggestions">{`Ways teams address this (${suggestionCount})`}</a>
        </p>
      ) : null}
      <h3 className="question-content__heading">What good looks like</h3>
      <p className="question-content__body">{question.expectedPractice}</p>
      <h3 className="question-content__heading">Why this is asked</h3>
      <p className="question-content__body">{question.whyAsked}</p>
    </div>
  );
}
