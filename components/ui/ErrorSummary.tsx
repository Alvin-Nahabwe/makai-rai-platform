import type { ReactElement, Ref } from 'react';
import './ErrorSummary.css';

export type ErrorSummaryProps = {
  title: string;
  errors: ReadonlyArray<{ fieldId: string; message: string }>;
  /** Attached to the title, the element the caller focuses. */
  ref?: Ref<HTMLHeadingElement>;
};

/**
 * The errors of a form, each a link to its field (plan 1A Task 4; modern-web-guidance accessible-error-announcement).
 * The caller moves focus to the title after a failed submit (it takes `tabIndex={-1}` and the `ref`), so a screen reader
 * reads it and the person can go on into the list; it is not a live region. The focused element holds the title's text
 * alone, which is how the adopting screen's protected test finds it (e2e/decision-save.spec.ts:294). Each link is `#`
 * and the field's id, nothing else. Renders nothing when there is no error.
 */
export function ErrorSummary({ title, errors, ref }: ErrorSummaryProps): ReactElement | null {
  if (errors.length === 0) return null;
  return (
    <div className="ui-error-summary">
      <h2 className="ui-error-summary__title" tabIndex={-1} ref={ref}>{title}</h2>
      <ul className="ui-error-summary__list">
        {errors.map((e, i) => <li key={`${i}-${e.fieldId}`}><a href={`#${e.fieldId}`}>{e.message}</a></li>)}
      </ul>
    </div>
  );
}
