'use client';

import Link from 'next/link';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { QuestionFindingLink, type QuestionFindingLinkProps } from '@/components/findings/QuestionFindingLink';
import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * Whether the decision form's Save waits for an upload or a link, or its request is out (DecisionForm `held`). While it is,
 * the card's own ways off the page are text, not links (review B-I1 for Next, A I-1 for All questions, B M-r4-3 and A M-1
 * for the foot's History and finding links): following one unmounts the form and its uploads, and the pressed Save never
 * goes. False outside the form (nothing to hold).
 */
export const SaveHeldContext = createContext(false);

/**
 * The attribute on a link (or its wrapper) that a held Save turns into text. When such a link has focus as the hold starts,
 * the form moves focus to its save bar after the render (DecisionForm `leaveHeldLink`), never to the page body.
 */
export const HELD_ON_SAVE = 'data-held-on-save';

/** A link of the card's foot: a next/link, or its words as quiet text (`data-link-held`) while a Save waits or is out. */
export function HeldLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  const held = useContext(SaveHeldContext);
  return held
    ? <span className="decision-held-link" data-link-held>{children}</span>
    : <Link href={href} {...{ [HELD_ON_SAVE]: '' }}>{children}</Link>;
}

/**
 * The page's own finding control (components/findings/QuestionFindingLink.tsx: "View the finding", "Raise a finding about
 * this question"), or, while a Save waits or is out, the same lines with the links' words as quiet text.
 */
export function HeldFindingLink(p: QuestionFindingLinkProps): ReactElement | null {
  const held = useContext(SaveHeldContext);
  if (p.openFinding === null && !p.canRaise) return null;
  if (!held) return <div {...{ [HELD_ON_SAVE]: '' }}><QuestionFindingLink {...p} /></div>;
  const L = QUESTION_COPY.findingLink;
  return (
    <div>
      {p.openFinding === null ? null : (
        <p>{p.openFinding.closable === true ? L.closable : L.open} <span className="decision-held-link" data-link-held>{L.view}</span></p>
      )}
      {p.canRaise ? <p><span className="decision-held-link" data-link-held>{L.raise}</span></p> : null}
    </div>
  );
}
