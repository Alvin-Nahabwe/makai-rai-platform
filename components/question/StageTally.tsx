import type { ReactElement } from 'react';
import { tallyOfRows, tallyParts } from '@/lib/question/route';
import type { StageRow } from '@/lib/question/stageList';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { MarkShape } from '@/components/ui/StatusMark';
import { Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import type { StatusMarkKind } from '@/components/ui/types';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import {
  TERM_DONE, TERM_DOES_NOT_APPLY, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY, TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION,
} from '@/lib/vocabulary/terms';
import './stage-route.css';

/** The words of the question page's strip (its tips' names and the personal data question's tally words). */
const FR = QUESTION_COPY.frame;

/**
 * The vocabulary entry each tally word is defined by, as components/question/QuestionTopStrip.tsx reads it. "No decision"
 * is not defined at first use (defineOnFirstUse false), so it has no (i); the personal data question's tip is its own.
 */
const TALLY_TERM: Readonly<Partial<Record<StatusMarkKind, DefinedEntry>>> = {
  done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE, does_not_apply: TERM_DOES_NOT_APPLY,
};

/**
 * A stage's tally in words (spec 7.2): the count of every question of the stage, then each kind beside its mark. Moved verbatim from
 * the stage page (S-11) so the end-of-stage screen (design G3) reads the same words from the same rows.
 */
export function StageTally({ rows, marks }: { rows: readonly StageRow[]; marks: Readonly<Record<string, StatusMarkKind>> }): ReactElement {
  return (
    <div className="stage-route__tally">
      <p className="stage-route__count" data-stage-summary="">{STAGE_LIST_COPY.count(rows.length)}</p>
      <ul className="stage-route__tally-parts" role="list">
        {tallyParts(tallyOfRows(rows, marks)).map((t) => {
          // The owner's ruling of 15 Nov, 11:00: an (i) beside each word the vocabulary defines at first use, as the question
          // page's strip does. Reflow at 320 px (fix round 3, S3-N1): the words may wrap, but the mark, the count and the
          // first word stay together, and the last word stays with its (i). The mark is the kit's shape alone, beside its
          // words (fix round 4, N3: no hidden words to read twice or to copy); the words are the list copy's (M-A3).
          const of = t.kind === 'scope_answered' ? TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION : TALLY_TERM[t.kind];
          const tip = of === undefined ? null
            : <TermTip of={of} label={t.kind === 'scope_answered' ? FR.whatIsTerm(of.term) : FR.whatMeans(of.term)} />;
          const [first, ...rest] = t.word.split(' ');
          const last = rest.length > 0 ? rest[rest.length - 1] : null;
          const middle = rest.slice(0, -1).join(' ');
          const words = (
            <>
              <span className="stage-route__keep stage-route__lead">
                <MarkShape kind={t.kind} size={16} /><span className="stage-route__words">{`${t.n} ${first}`}</span>{last === null ? tip : null}
              </span>
              {last === null ? null : <>{` ${middle}${middle === '' ? '' : ' '}`}{tip === null ? last : <span className="stage-route__keep">{last}{tip}</span>}</>}
            </>
          );
          return (
            <li key={t.kind} className="stage-route__tally-part">
              {of === undefined ? words : <Term of={of}>{words}</Term>}
              {t.extra !== null ? ` ${t.extra}` : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
