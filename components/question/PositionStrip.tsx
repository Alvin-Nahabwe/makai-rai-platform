import Link from 'next/link';
import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MarkShape, statusMarkWords } from '@/components/ui/StatusMark';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { positionWords } from '@/lib/ui/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import type { Neighbour } from '@/components/question/neighbour';

const F = QUESTION_COPY.frame;

export type PositionStripProps = {
  previous: Neighbour | null; next: Neighbour | null;
  /** This question's place, as the panel counts it. */
  n: number; total: number;
  /** Each question's mark in the stage (`loadStagePage`'s `marks`), and the personal data question's answer for its words. */
  marks: Readonly<Record<string, StatusMarkKind>>; currentId: string; scopeAnswer: ScopeAnswer | null;
};

/**
 * The position strip of the question page under 1160px (spec 9.3 "Narrow"; phone sketch workspace-phone-saved.html
 * `.strip`): `‹` with the previous question's mark and number, the current question's mark in its ring with "Question n
 * of N" in bold, then the next question's number and mark with `›`. Previous and next are the panel's `previousId` and
 * `nextId`, so they skip a question the personal data answer switched off. Each link's accessible name is the question in
 * words with its number and status in words; the marks are drawn hidden. No "All questions" here: on narrow screens the
 * top bar holds it (coordinator's ruling 5). workspace.css hides the strip from 1160px, where the breadcrumb and the route
 * column do its job.
 */
export function PositionStrip({ previous, next, n, total, marks, currentId, scopeAnswer }: PositionStripProps): ReactElement {
  // The stage page gives a mark for every question of the stage, from the same running content as the panel: a question
  // without one is a defect, said by name, not a mark to guess.
  const kindOf = (id: string): StatusMarkKind => {
    const kind = marks[id];
    if (kind === undefined) throw new Error(`PositionStrip: the stage's marks have none for ${id}`);
    return kind;
  };
  const words = (id: string): string => {
    const kind = kindOf(id);
    return statusMarkWords(kind, kind === 'scope_answered' && scopeAnswer !== null ? { scopeAnswer } : {});
  };
  const mark = (id: string, size: 16 | 20) => (
    <span className="ui-mark" data-mark-kind={kindOf(id)}><MarkShape kind={kindOf(id)} size={size} /></span>
  );
  /**
   * A link's name, written in its content so the number it shows is part of what it says (WCAG 2.5.3): the words around
   * the number are visually hidden, the number shows. `name` holds the number once, as "question n".
   */
  const named = (name: string, n: number) => {
    const found = name.lastIndexOf(`question ${n}`);
    if (found < 0) throw new Error(`PositionStrip: the link's words do not hold "question ${n}"`);
    const at = found + `question `.length;
    return (
      <span><span className="visually-hidden">{name.slice(0, at)}</span>{n}<span className="visually-hidden">{name.slice(at + String(n).length)}</span></span>
    );
  };
  /** "Question n of N", its first word in a span the narrowest screens hide (the place stays). */
  const place = (at: number, of: number) => {
    const words = positionWords(at, of);
    const i = words.indexOf(`${at} `);
    if (i <= 0) throw new Error(`PositionStrip: "${words}" does not hold the place ${at}`);
    return <><span className="position-strip__word">{words.slice(0, i)}</span>{words.slice(i)}</>;
  };
  return (
    <nav className="position-strip" aria-label={QUESTION_COPY.nav.label}>
      {previous !== null ? (
        <Link className="position-strip__step" href={previous.href}>
          <Icon name="chevron-left" size={20} />{mark(previous.questionId, 16)}{named(F.previous(previous.text, previous.number, words(previous.questionId)), previous.number)}
        </Link>
      ) : <span className="position-strip__step" />}
      <p className="position-strip__here" aria-current="step">
        <span className="position-strip__ring">{mark(currentId, 20)}</span>
        <b>{place(n, total)}</b>
        <span className="visually-hidden">{F.hereStatus(words(currentId))}</span>
      </p>
      {next !== null ? (
        <Link className="position-strip__step position-strip__step--next" href={next.href}>
          {named(F.next(next.text, next.number, words(next.questionId)), next.number)}{mark(next.questionId, 16)}<Icon name="chevron-right" size={20} />
        </Link>
      ) : <span className="position-strip__step" />}
    </nav>
  );
}
