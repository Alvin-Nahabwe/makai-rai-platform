import type { ReactElement, Ref } from 'react';
import './ErrorSummary.css';

export type ErrorSummaryProps = {
  title: string;
  errors: ReadonlyArray<{ fieldId: string; message: string }>;
  ref?: Ref<HTMLDivElement>;
};

/**
 * The errors of a form, each a link to its field (plan 1A Task 4; modern-web-guidance accessible-error-announcement).
 * The caller moves focus here after a failed submit, so a screen reader reads the title and the list; it is not a live
 * region. Each link is `#` and the field's id, nothing else. Renders nothing when there is no error.
 */
export function ErrorSummary({ title, errors, ref }: ErrorSummaryProps): ReactElement | null {
  if (errors.length === 0) return null;
  return (
    <div className="ui-error-summary" tabIndex={-1} ref={ref}>
      <h2 className="ui-error-summary__title">{title}</h2>
      <ul className="ui-error-summary__list">
        {errors.map((e, i) => <li key={`${i}-${e.fieldId}`}><a href={`#${e.fieldId}`}>{e.message}</a></li>)}
      </ul>
    </div>
  );
}
