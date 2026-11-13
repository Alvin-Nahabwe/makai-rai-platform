import type { ReactElement, ReactNode } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { StatusMark } from '@/components/ui/StatusMark';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { UI_COPY } from '@/lib/ui/copy';
import './StatusMark.css';
import './ItemPlate.css';

export type ItemPlateProps = {
  /** With `href`, the whole plate is the link's target: no interactive content here. */
  title: ReactNode;
  code?: string;
  /** One line of state, after the code; `undefined`, `null` and `false` show nothing. With `href`, no interactive content. */
  state?: ReactNode;
  mark?: StatusMarkKind;
  /** Only with `mark="done"`: the mark adds ", no evidence attached" (spec 7.2). */
  noEvidence?: boolean;
  /** Only with `mark="scope_answered"`: the answer the mark's words give ("Answer: Yes"). */
  scopeAnswer?: ScopeAnswer;
  /** An application path, passed to the link as given: callers pass their own addresses. */
  href?: string;
  current?: boolean;
  /** Makes the title a heading of this level; without it the title is not a heading. */
  headingLevel?: 2 | 3 | 4;
};

const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false;

/**
 * One item of a list, such as a question (plan 1A Task 5): its name in words, then its small code, then its status mark
 * and one line of state (voice rule 8). With an address the name is a link that never prefetches (ListLink: a plate
 * sits in lists of up to 22) and the whole plate is its target, so the title and the state hold no interactive content.
 * `current` adds the pin "You are here" and sets aria-current="step" on the link (on the name when there is no link).
 * The mark is StatusMark as it is, alone in __mark, so no element of the plate's own carries a mark class or
 * data-mark-kind. The state, and the title when it is not a heading, are <div>s, so a caller's block content is valid.
 */
export function ItemPlate({ title, code, state, mark, noEvidence, scopeAnswer, href, current = false, headingLevel }: ItemPlateProps): ReactElement {
  const ariaCurrent = current ? 'step' : undefined;
  const name = href === undefined
    ? (current ? <span aria-current={ariaCurrent}>{title}</span> : title)
    : <ListLink className="ui-plate__link" aria-current={ariaCurrent} href={href}>{title}</ListLink>;
  const Title = headingLevel === undefined ? 'div' : (`h${headingLevel}` as const);
  const classes = ['ui-plate', current ? 'ui-plate--current' : null, href === undefined ? null : 'ui-plate--link'].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <Title className="ui-plate__title">{name}</Title>
      {shown(code) ? <p className="ui-plate__code">{code}</p> : null}
      {mark === undefined ? null : <div className="ui-plate__mark"><StatusMark kind={mark} noEvidence={noEvidence} scopeAnswer={scopeAnswer} /></div>}
      {shown(state) ? <div className="ui-plate__state">{state}</div> : null}
      {current ? <p className="ui-plate__pin">{UI_COPY.plate.youAreHere}</p> : null}
    </div>
  );
}
