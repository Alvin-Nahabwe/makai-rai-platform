import type { ReactElement } from 'react';
import './Skeleton.css';

export type SkeletonProps = {
  /** What is loading, said once through a visually hidden status line ("Loading the findings"). */
  label: string;
  variant?: 'text' | 'plate' | 'table';
  lines?: number;
};

/**
 * A static placeholder while content loads (plan 1A Task 6, decision B12): nothing moves, no shimmer, because nothing
 * on a page load moves (spec 7.5). The drawn lines are hidden from assistive technology; the label is the one thing read.
 */
export function Skeleton({ label, variant = 'text', lines = 3 }: SkeletonProps): ReactElement {
  return (
    <div className={variant === 'text' ? 'ui-skeleton' : `ui-skeleton ui-skeleton--${variant}`}>
      <p role="status" className="visually-hidden">{label}</p>
      <div aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <span key={i} className="ui-skeleton__line" />)}
      </div>
    </div>
  );
}
