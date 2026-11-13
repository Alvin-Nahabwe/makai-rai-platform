import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { MarkShape, statusMarkWords } from '@/components/ui/StatusMark';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { tallyWords } from '@/lib/ui/copy';
import type { Tally } from '@/lib/ui/marks';
import './StatusMark.css';
import './RouteRow.css';

export type RouteRowStop = {
  id: string;
  kind: StatusMarkKind;
  title: string;
  href?: string;
  current?: boolean;
  /** The personal data question's answer, which a `scope_answered` stop's words give. */
  scopeAnswer?: ScopeAnswer;
};

export type RouteRowProps = { label: string; stops: readonly RouteRowStop[]; tally: Tally };

/**
 * A stage as a row of marks, one stop per question in question order, joined by a line (spec 7.2). Each stop's
 * accessible text is "<title>: <status words>"; the current stop is ringed and carries aria-current="step". The tally
 * in words follows. There is no fill, no percentage and no total. A stop with an address is a link that does not
 * prefetch (UX-37: a stage has up to 22 of them). The list keeps role="list" because Safari drops the list role, and so
 * its label, from a list styled `list-style: none`.
 */
export function RouteRow({ label, stops, tally }: RouteRowProps): ReactElement {
  return (
    <div className="ui-route-row">
      <ol className="ui-route-row__stops" role="list" aria-label={label}>
        {stops.map((stop) => {
          const content = (
            <>
              <MarkShape kind={stop.kind} size={20} />
              <span className="visually-hidden">{`${stop.title}: ${statusMarkWords(stop.kind, { scopeAnswer: stop.scopeAnswer })}`}</span>
            </>
          );
          const current = stop.current ? 'step' : undefined;
          return (
            <li key={stop.id} className={stop.current ? 'ui-route-row__stop ui-route-row__stop--current' : 'ui-route-row__stop'} data-mark-kind={stop.kind}>
              {stop.href
                ? <ListLink href={stop.href} aria-current={current} className="ui-route-row__point">{content}</ListLink>
                : <span className="ui-route-row__point" aria-current={current}>{content}</span>}
            </li>
          );
        })}
      </ol>
      <p className="ui-route-row__tally">{tallyWords(tally)}</p>
    </div>
  );
}
