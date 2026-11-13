import type { ReactElement, ReactNode } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { StatusMark } from '@/components/ui/StatusMark';
import type { StatusMarkKind } from '@/components/ui/types';
import { UI_COPY } from '@/lib/ui/copy';
import './StatusMark.css';
import './ItemPlate.css';

export type ItemPlateProps = {
  title: ReactNode;
  code?: string;
  /** One line of state, after the code. */
  state?: ReactNode;
  mark?: StatusMarkKind;
  /** An application path, passed to the link as given: callers pass their own addresses. */
  href?: string;
  current?: boolean;
  /** Makes the title a heading of this level; without it the title is not a heading. */
  headingLevel?: 2 | 3 | 4;
};

/**
 * One item of a list, such as a question (plan 1A Task 5): its name in words, then its small code, then its status mark
 * and one line of state (voice rule 8). With an address the name is a link that never prefetches (ListLink: a plate
 * sits in lists of up to 22) and the whole plate is its target. `current` adds the pin "You are here" and sets
 * aria-current="step" on the link (on the name when there is no link). The mark is StatusMark as it is, alone in
 * __mark, so no element of the plate's own carries a mark class or data-mark-kind.
 */
export function ItemPlate({ title, code, state, mark, href, current = false, headingLevel }: ItemPlateProps): ReactElement {
  const ariaCurrent = current ? 'step' : undefined;
  const name = href === undefined
    ? (current ? <span aria-current={ariaCurrent}>{title}</span> : title)
    : <ListLink className="ui-plate__link" aria-current={ariaCurrent} href={href}>{title}</ListLink>;
  const Title = headingLevel === undefined ? 'p' : (`h${headingLevel}` as const);
  const classes = ['ui-plate', current ? 'ui-plate--current' : null, href === undefined ? null : 'ui-plate--link'].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <Title className="ui-plate__title">{name}</Title>
      {code === undefined ? null : <p className="ui-plate__code">{code}</p>}
      {mark === undefined ? null : <div className="ui-plate__mark"><StatusMark kind={mark} /></div>}
      {state === undefined ? null : <p className="ui-plate__state">{state}</p>}
      {current ? <p className="ui-plate__pin">{UI_COPY.plate.youAreHere}</p> : null}
    </div>
  );
}
