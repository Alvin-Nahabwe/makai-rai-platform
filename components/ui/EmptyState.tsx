import type { ReactElement, ReactNode } from 'react';
import './EmptyState.css';

export type EmptyStateProps = {
  title: string;
  /** Why the place is empty and how it fills (voice rule 2). */
  children: ReactNode;
  action?: ReactNode;
};

/** An empty place (plan 1A Task 6): what is missing, why, and how it fills, with at most one action. */
export function EmptyState({ title, children, action }: EmptyStateProps): ReactElement {
  return (
    <div className="ui-empty">
      <p className="ui-empty__title">{title}</p>
      <div className="ui-empty__body">{children}</div>
      {action === undefined || action === null || action === false ? null : <div className="ui-empty__action">{action}</div>}
    </div>
  );
}
