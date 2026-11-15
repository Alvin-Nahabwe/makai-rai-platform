import type { ReactElement, ReactNode, Ref } from 'react';

export type AuthCardProps = {
  title: ReactNode; lead?: ReactNode; children: ReactNode; footer?: ReactNode;
  /** For a page whose form is replaced by its answer: given, the heading takes focus by script only (tabindex -1), so the page can move focus to it. */
  titleRef?: Ref<HTMLHeadingElement>;
};

/**
 * The content of a door page's card (plan 1B Task 2, lead's ruling L5-7): the page's one <h1>, its lead, the form, and the
 * footer links, in that order. The gate frame (components/layout/GateFrame.tsx) already draws the card itself, its white
 * surface, border and width, so this is structure only, never a second box. No logo: the logo lives in the frame's
 * column (ruling L5-8), not in the card.
 *
 * The rules of its lead and of a form's status line are in the gate frame's public sheet (components/layout/gate.css),
 * which every page that draws it loads; the footer's are in ./auth.css. This module brings no stylesheet, so S-04, which
 * passes no footer, draws the card without auth.css (the lean frame, owner, 15 Nov 15:35); every other door page imports
 * it through ./AuthCard, which adds that sheet.
 */
export function AuthCard({ title, lead, children, footer, titleRef }: AuthCardProps): ReactElement {
  return (
    <div className="auth-view">
      <h1 tabIndex={titleRef === undefined ? undefined : -1} ref={titleRef}>{title}</h1>
      {lead === undefined || lead === null ? null : <div className="auth-view__lead">{lead}</div>}
      {children}
      {footer === undefined || footer === null ? null : <div className="auth-view__footer">{footer}</div>}
    </div>
  );
}
