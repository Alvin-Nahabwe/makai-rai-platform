import Link from 'next/link';
import type { ReactElement } from 'react';
import { QUESTION_COPY } from '@/lib/question/copy';
import type { Neighbour } from '@/components/question/neighbour';

const Q = QUESTION_COPY;

/**
 * The way on at the foot of the main column (workshop walk S9): "Next question: {its words}", or on the stage's last
 * question the sentence that says so, then All questions. A paragraph, so the page keeps its navigation landmarks to the
 * strips. The reading view shows it after the seal note; the decision slot's stub shows it for a person who may record
 * until lane 2's card, which holds its own way on, merges.
 */
export function WayOn({ next, stageHref }: { next: Pick<Neighbour, 'href' | 'text'> | null; stageHref: string }): ReactElement {
  return (
    <p className="question-foot" data-region="way-on">
      {next !== null
        ? <Link href={next.href}>{Q.foot.next(next.text)}</Link>
        : <span>{Q.foot.last}</span>}
      <Link href={stageHref}>{Q.nav.allQuestions}</Link>
      {next === null ? <Link href={`${stageHref}/end`}>{Q.end.link}</Link> : null}
    </p>
  );
}
