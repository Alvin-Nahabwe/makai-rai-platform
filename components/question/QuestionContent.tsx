import type { LoadedQuestion } from '@/types/content';
import type { ReactElement, ReactNode } from 'react';
import { Definition, Term } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import { QUESTION_COPY } from '@/lib/question/copy';
import { TERM_RISK_AREA } from '@/lib/vocabulary/terms';
import './QuestionContent.css';

export type QuestionContentProps = {
  question: LoadedQuestion;
  /** n in "Ways teams address this (n)": SUG's `suggestionCount`. At 0 there is no control. */
  suggestionCount: number;
  /** The question's risk areas (lib/content/riskAreas.ts `riskAreasOf`), in order; none for the personal data question. */
  riskAreas: ReadonlyArray<{ id: string; name: string; href: string }>;
  /** The list of ways teams address this (SuggestedControls), shown only inside the folded control. */
  children?: ReactNode;
};

/** The id of the aside's first heading, which names the aside. */
const HEADING_ID = 's12-guidance';
const C = QUESTION_COPY.content;

/**
 * The guidance of the question page (UX-08, FR-CNT-02; sketch assigned.html `aside`): "What good looks like", "Why this is
 * asked" with, directly under it, the question's risk areas as linked labels (owner 17.5, plan 1C Task 4: each the area's
 * name in words, its code after it in small type, to its card on the framework page), then "Ways teams address this (n)"
 * as ONE `<details>`, folded by default, whose summary is the link-styled control with the book icon and whose content is
 * the list, opening in place (spec 9.3). It is the page's `<aside>`, named by its first heading.
 *
 * A server component (UX-36): all of it is in the page's HTML before any script runs, and every content text is a React
 * child, so it is escaped as text. The question's text is the page's `h1` and its id and topic the code line under it, so
 * neither is repeated here; the headings are `h2`, one level below that `h1`.
 */
export function QuestionContent({ question, suggestionCount, riskAreas, children }: QuestionContentProps): ReactElement {
  return (
    <aside className="question-content" data-region="guidance" aria-labelledby={HEADING_ID}>
      <h2 id={HEADING_ID}>{C.goodPractice}</h2>
      <p className="question-content__body">{question.expectedPractice}</p>
      <h2>{C.whyAsked}</h2>
      <p className="question-content__body">{question.whyAsked}</p>
      {riskAreas.length > 0 ? (
        <div className="question-content__areas">
          <p className="question-content__areas-label"><Term of={TERM_RISK_AREA}>{QUESTION_COPY.frame.riskAreas}</Term> <Definition of={TERM_RISK_AREA} /></p>
          <ul className="question-content__area-list" role="list">
            {riskAreas.map((a) => (
              <li key={a.id}><a href={a.href}>{a.name} <small className="question-content__area-code">{a.id}</small></a></li>
            ))}
          </ul>
        </div>
      ) : null}
      {suggestionCount > 0 ? (
        <details className="question-content__ways" id="suggestions">
          <summary className="question-content__ways-summary"><Icon name="book-open" size={18} />{C.jump(suggestionCount)}</summary>
          <div className="question-content__ways-list">{children}</div>
        </details>
      ) : null}
    </aside>
  );
}
