import type { ReactElement } from 'react';
import { Term } from '@/components/ui/Definition';
import { ListLink } from '@/components/ui/ListLink';
import { MarkShape, statusMarkWords } from '@/components/ui/StatusMark';
import { TermTip } from '@/components/ui/TermTip';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { tallyWords, UI_COPY } from '@/lib/ui/copy';
import type { Tally } from '@/lib/ui/marks';
import { TERM_DOES_NOT_APPLY, TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';
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

/**
 * The status kinds whose tally words the vocabulary defines on first use, each with its entry. "No decision" is not defined
 * on first use, and the answered personal data question's tally words ("answered") are not that question's term, so
 * neither is here and neither can be named in `define`.
 */
const DEFINED = {
  done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE, does_not_apply: TERM_DOES_NOT_APPLY,
} as const satisfies Partial<Record<StatusMarkKind, DefinedEntry>>;
export type DefinedTallyKind = keyof typeof DEFINED;

/**
 * The tally's kinds in its order (lib/ui/copy.ts TALLY_WORDS): the order tallyWords writes them in. A record keyed by every
 * StatusMarkKind, so a kind added later fails to compile here instead of vanishing from the tally (M2); its key order is
 * the order.
 */
const TALLY_RANK: Readonly<Record<StatusMarkKind, true>> = {
  done: true, partly: true, not_yet: true, not_applicable: true, does_not_apply: true, scope_answered: true, no_decision: true,
};
const TALLY_ORDER = Object.keys(TALLY_RANK) as readonly StatusMarkKind[];

export type RouteRowProps = {
  label: string; stops: readonly RouteRowStop[]; tally: Tally;
  /**
   * The kinds whose tally words are their term's first use on the screen, each with the accessible name of its (i) button
   * (from the caller's copy module). The caller decides first use; a kind with no count draws nothing.
   */
  define?: Readonly<Partial<Record<DefinedTallyKind, string>>>;
};

const isDefined = (kind: StatusMarkKind): kind is DefinedTallyKind => kind in DEFINED;

/**
 * A stage as a row of marks, one stop per question in question order, joined by a line (spec 7.2). Each stop's
 * accessible text is "<title>: <status words>"; the current stop is ringed and carries aria-current="step". The tally
 * follows as a list keyed by the marks (the sketch's counts): per kind with a count, its 16 px shape, the count in bold and
 * the kind's words, the count never apart from its word; read together the items say tallyWords(tally). A kind named in
 * `define` is marked as its term and carries the (i), beside the word, with the vocabulary's sentence (TermTip; the owner's ruling of 15 November 2026,
 * 11:05). There is no fill, no percentage and no total. A stop with an address is a link that does not
 * prefetch (UX-37: a stage has up to 22 of them). The list keeps role="list" because Safari drops the list role, and so
 * its label, from a list styled `list-style: none`.
 */
export function RouteRow({ label, stops, tally, define }: RouteRowProps): ReactElement {
  return (
    <div className="ui-route-row">
      <ol className="ui-route-row__stops" role="list" aria-label={label}>
        {stops.map((stop) => {
          const content = (
            <>
              <MarkShape kind={stop.kind} size={20} />
              {/* The title sits in an element of its own, so it is a whole text node whatever renders it: that is how the
                  claims crawl knows an allow-listed question text (e2e/claims-crawl.spec.ts, FR-PUB-01). It reads the same. */}
              <span className="visually-hidden"><span>{stop.title}</span>{`: ${statusMarkWords(stop.kind, { scopeAnswer: stop.scopeAnswer })}`}</span>
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
      <Tally tally={tally} define={define} />
    </div>
  );
}

/**
 * The tally as a list. Each item's words are tallyWords for that kind alone ("9 done (2 with no evidence attached)"), so the
 * kit's words, their agreement in number and the evidence caveat stay in lib/ui/copy.ts; the count they start with is drawn
 * in bold. __tests__/unit/ui/route-row.test.tsx pins that the items read together are tallyWords(tally).
 */
function Tally({ tally, define }: Pick<RouteRowProps, 'tally' | 'define'>): ReactElement {
  const kinds = TALLY_ORDER.filter((kind) => (tally[kind] ?? 0) > 0);
  if (kinds.length === 0) return <p className="ui-route-row__tally">{UI_COPY.tally.none}</p>;
  return (
    <ul className="ui-route-row__tally" role="list">
      {kinds.map((kind) => {
        const count = tally[kind] ?? 0;
        const own = `${count} `;
        const word = tallyWords({ [kind]: count }).slice(own.length);
        const caveat = kind === 'done' ? tallyWords({ done: count, doneNoEvidence: tally.doneNoEvidence }).slice(own.length + word.length) : '';
        const label = isDefined(kind) ? define?.[kind] : undefined;
        const term = label !== undefined && isDefined(kind) ? DEFINED[kind] : null;
        // The count, its word and the (i) are one nowrap unit (M1), so neither the word nor the (i) parts from the count. Only
        // the evidence caveat may take a line of its own, under the words, when the line is too narrow (320 px, WCAG 1.4.10).
        return (
          <li key={kind} className="ui-route-row__tally-item" data-tally-kind={kind}>
            <MarkShape kind={kind} size={16} />
            <span className="ui-route-row__tally-words">
              <span className="ui-route-row__tally-count">
                <span className="ui-route-row__tally-word"><b>{count}</b>{' '}{term === null ? word : <Term of={term}>{word}</Term>}</span>
                {term === null || label === undefined ? null : <TermTip of={term} label={label} />}
              </span>
              {caveat === '' ? null : <>{' '}<span className="ui-route-row__tally-caveat">{caveat.trim()}</span></>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
