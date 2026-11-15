import Link from 'next/link';
import type { ReactElement } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Definition } from '@/components/ui/Definition';
import { QUESTION_COPY } from '@/lib/question/copy';
import { TERM_SEAL, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';
import type { SealRef } from '@/types/seal';
import './reading.css';

const Q = QUESTION_COPY;
const R = QUESTION_COPY.reading;

/** The next question as the frame passes it to the decision card (lane 2's DecisionCard seam): the same shape here. */
export type NextQuestion = { questionId: string; text: string; href: string; number: number; total: number };

export type ReadingAsideProps = {
  /** The seals holding the current version (QuestionPanelData.seals); empty when it is in none. */
  seals: SealRef[];
  /** The current version's number (a withdrawal too: a seal can keep it), which those seals keep; null with no decision. */
  versionNumber: number | null;
  /** decisionFormNote's line for this role; null in an archived project (its banner says it) or for a writer. */
  note: string | null;
  next: NextQuestion | null;
  stageTitle: string;
  stageHref: string;
};

/**
 * The eye beside the role note (directions/surfaces/viewer-reading.png). The kit has no eye among its 28 icons
 * (components/ui/types.ts IconName), and components/ui is not this lane's to change, so it is drawn here from the kit's own
 * family: Lucide's "eye" (ISC, components/ui/LICENSE-lucide.txt), stroked in currentColor at the kit's weight, hidden from
 * assistive technology like every kit icon.
 */
function EyeMark(): ReactElement {
  return (
    <svg className="reading-aside__eye" width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx={12} cy={12} r={3} />
    </svg>
  );
}

/** One seal per review, its highest holding the version (as components/review/SealNote.tsx chooses). */
function highestPerReview(seals: SealRef[]): SealRef[] {
  const highest = new Map<string, SealRef>();
  for (const s of seals) {
    const cur = highest.get(s.reviewId);
    if (cur === undefined || s.sealNumber > cur.sealNumber) highest.set(s.reviewId, s);
  }
  return [...highest.values()];
}

/**
 * The reader's aside (plan 1C Task 7; directions/surfaces/viewer-reading.png), placed by the frame at the top of the
 * guidance column, above "What good looks like": "In a sealed copy" with one sentence per review naming the seal and the
 * version it keeps and, in small text, the vocabulary's definitions of a stage review and a seal (only when the version
 * is in a seal); the role note in a small bordered box with the eye (none in an archived project, whose banner says it);
 * then the way on: "Next: question n" as the page's one primary link (a reader has no Save) with "Question n of N in
 * <stage>" under it, or on the stage's last question the last-question sentence and All questions. A server component.
 */
export function ReadingAside({ seals, versionNumber, note, next, stageTitle, stageHref }: ReadingAsideProps): ReactElement {
  const sealed = versionNumber === null ? [] : highestPerReview(seals);
  return (
    <div className="reading-aside" data-region="reading-aside">
      {sealed.length > 0 && versionNumber !== null ? (
        // A part of the reader's aside, not a landmark of its own (review M7).
        <div className="reading-aside__seal">
          <h2>{R.sealedHeading}</h2>
          {sealed.map((s) => <p key={s.reviewId}>{R.sealKeeps(s.sealNumber, s.reviewName, versionNumber)}</p>)}
          <p className="reading-aside__defs"><Definition of={TERM_STAGE_REVIEW} /> <Definition of={TERM_SEAL} /></p>
        </div>
      ) : null}
      {note === null ? null : <p className="reading-aside__note" data-permission-note><EyeMark /><span>{note}</span></p>}
      <div className="reading-aside__next">
        {next === null ? (
          <>
            <p>{Q.foot.last}</p>
            <p><Link href={stageHref}>{Q.nav.allQuestions}</Link></p>
          </>
        ) : (
          <>
            <ButtonLink variant="primary" href={next.href} icon="chevron-right" iconPosition="end">{R.next(next.number)}</ButtonLink>
            <p>{Q.nav.position(next.number, next.total, stageTitle)}</p>
          </>
        )}
      </div>
    </div>
  );
}
