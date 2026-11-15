import type { ReactElement, ReactNode } from 'react';
import './auth.css';

export type AuthCardProps = { title: ReactNode; lead?: ReactNode; children: ReactNode; footer?: ReactNode };

/**
 * The content of a door page's card (plan 1B Task 2, lead's ruling L5-7): the page's one <h1>, its lead, the form, and the
 * footer links, in that order. The gate frame (components/layout/GateFrame.tsx) already draws the card itself, its white
 * surface, border and width, so this is structure only, never a second box. No logo: the logo lives in the frame's
 * column (ruling L5-8), not in the card.
 */
export function AuthCard({ title, lead, children, footer }: AuthCardProps): ReactElement {
  return (
    <div className="auth-view">
      <h1>{title}</h1>
      {lead === undefined || lead === null ? null : <div className="auth-view__lead">{lead}</div>}
      {children}
      {footer === undefined || footer === null ? null : <div className="auth-view__footer">{footer}</div>}
    </div>
  );
}
