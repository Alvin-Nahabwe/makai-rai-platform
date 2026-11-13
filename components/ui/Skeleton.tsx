import type { ReactElement } from 'react';
import './Skeleton.css';

export type SkeletonProps = {
  /** What is loading ("Loading the findings"), in a visually hidden status line. */
  label: string;
  variant?: 'text' | 'plate' | 'table';
  lines?: number;
};

/**
 * A static placeholder while content loads (plan 1A Task 6, decision B12): nothing moves, no shimmer, because nothing
 * on a page load moves (spec 7.5). The drawn lines are hidden from assistive technology; the label is the one thing read.
 *
 * The visually hidden `role="status"` line says what is loading to assistive technology that reads it. It is inserted
 * already holding its text, which is often not announced, and no screen reader has confirmed that it is: do not rely
 * on it as an announcement. Use one Skeleton with a label per loading boundary (each is a status region of its own).
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
