import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ListLink } from '@/components/ui/ListLink';
import { MarkShape, StatusMark, statusMarkWords } from '@/components/ui/StatusMark';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { STAGE_LIST_COPY as L } from '@/lib/question/list/copy';
import { tallyOf } from '@/lib/ui/marks';
import { tallyWords } from '@/lib/ui/copy';
import type { RoutePart } from '@/lib/question/route';
import './route-line.css';

/** One question as the line shows it. The caller (StageQuestionList) shapes it; this file holds markup only. */
export type RouteLineItem = {
  questionId: string;
  title: string;
  href: string;
  mark: StatusMarkKind;
  /** Only with `mark="done"`: the words add ", no evidence attached". */
  noEvidence: boolean;
  /** Only with `mark="scope_answered"`: the answer the words give ("Answer: Yes"). */
  scopeAnswer?: ScopeAnswer;
  /** The open question: "You are here", the ring, aria-current. */
  here: boolean;
  /** The next question that applies: its meta line leads with "Next question". */
  next: boolean;
  /** Shown after the status only on the open question, as the sketch draws it; null otherwise. */
  version: number | null;
  /** The rest of the meta line, each part already in words (dates, findings, seal, good practice, the draft). */
  state: string[];
  /** The line after "Save all n now", for this question; null when there is none. */
  result: string | null;
};

const SEP = L.row.separator;

/** A question's row: one link holding the mark on the line, then the question in words and its meta line. */
function Row({ item }: { item: RouteLineItem }): ReactElement {
  const words = statusMarkWords(item.mark, { noEvidence: item.noEvidence, scopeAnswer: item.scopeAnswer });
  const after = [...(item.version === null ? [] : [L.line.version(item.version)]), ...item.state];
  return (
    <li className={item.here ? 'route-line__item route-line__item--here' : 'route-line__item'} data-question-id={item.questionId}>
      <ListLink className="route-line__link" href={item.href} aria-current={item.here ? 'step' : undefined}>
        {/* The mark sits on the line. Its words are the meta line's status, read once there, so the mark is hidden. */}
        <span className={item.here ? 'route-line__node route-line__node--here' : `route-line__node${item.mark === 'no_decision' ? ' route-line__node--dot' : ''}`} aria-hidden="true">
          <StatusMark kind={item.mark} size={24} words="hidden" noEvidence={item.noEvidence} scopeAnswer={item.scopeAnswer} />
        </span>
        <span className="route-line__text">
          {item.here ? <span className="route-line__pin">{L.line.youAreHere}</span> : null}
          <span className="route-line__title">{item.title}</span>
          <span className="route-line__meta">
            {item.next ? <><span className="route-line__next">{L.line.next}</span>{SEP}</> : null}
            <code className="route-line__code">{item.questionId}</code>{SEP}<span className="status-label">{words}</span>
            {after.length > 0 ? `${SEP}${after.join(SEP)}` : null}
          </span>
        </span>
      </ListLink>
      {item.result !== null ? <p className="stage-route__result">{item.result}</p> : null}
    </li>
  );
}

/**
 * A folded run: a native disclosure that opens the run's rows in place on the line, so it works without script and
 * every question stays one link away. Its summary names the run by its places in the stage, draws one small mark per
 * question in order, and gives the run's tally in words (the marks are shapes beside those words).
 */
function Run({ part }: { part: Extract<RoutePart<RouteLineItem>, { kind: 'run' }> }): ReactElement {
  const items = part.rows.map((r) => r.row);
  const tally = tallyOf(items.map((i) => i.mark), items.filter((i) => i.mark === 'done' && i.noEvidence).length);
  return (
    <li className="route-line__item route-line__item--run">
      <details className="route-line__run">
        <summary className="route-line__link route-line__summary">
          <span className="route-line__node route-line__node--run" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
          <span className="route-line__text">
            <span className="route-line__title">{L.line.run(part.first, part.last)}</span>
            {/* Read as text, the label and the tally are two phrases ("Questions 7 to 24, 18 no decision"), not one number run. */}
            <span className="visually-hidden">, </span>
            <span className="route-line__tally">
              {items.map((i) => <MarkShape key={i.questionId} kind={i.mark} size={16} />)}
              <span className="route-line__tally-words">{tallyWords(tally)}</span>
            </span>
          </span>
        </summary>
        <ol className="route-line__list route-line__list--run" role="list">
          {items.map((i) => <Row key={i.questionId} item={i} />)}
        </ol>
      </details>
    </li>
  );
}

/**
 * The stage's questions as one line (owner's answer R1, 15 November 2026; the sketch's `.route`): a navy rule with each
 * question's mark on it, the question in words clamped to two lines, and a meta line of its code and its status in words.
 * Rows and runs come from lib/question/route.ts (foldRoute); the rule itself is drawn by the `.route-line` wrapper the
 * caller puts round one or more of these lists.
 */
export function RouteLineList({ parts }: { parts: ReadonlyArray<RoutePart<RouteLineItem>> }): ReactElement {
  return (
    <ol className="route-line__list" role="list">
      {parts.map((p) => (p.kind === 'row'
        ? <Row key={p.row.questionId} item={p.row} />
        : <Run key={`run-${p.first}`} part={p} />))}
    </ol>
  );
}
