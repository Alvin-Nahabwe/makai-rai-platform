'use client';

import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { describedBy, FieldError, FieldHint, given } from '@/components/ui/TextInput';
import type { DateParts } from '@/components/ui/types';
import { UI_COPY } from '@/lib/ui/copy';
import './DateField.css';

export type DateFieldProps = {
  /** The boxes' ids are `${idPrefix}-day`, `-month` and `-year`. */
  idPrefix: string;
  legend: string;
  hint?: ReactNode;
  value: DateParts;
  onChange: (v: DateParts) => void;
  error?: string;
  /**
   * Says "(required)" after the legend. No box is natively required: a date may be given to the month or the year alone,
   * which the caller checks (lib/ui/dateParts.ts).
   */
  required?: boolean;
  /** Buttons after "Today", in this order, each filling the boxes with its value. */
  shortcuts?: ReadonlyArray<{ label: string; value: DateParts }>;
  showToday?: boolean;
  /** The error element's id, default `${idPrefix}-error`; the boxes reference it while there is an error. */
  errorId?: string;
  /** On the fieldset: it disables the boxes and the buttons. */
  disabled?: boolean;
};

const PARTS = ['day', 'month', 'year'] as const;

/** Today's date on this device, in the reader's own zone, as the three boxes. */
function todayParts(now: Date): DateParts {
  return { day: String(now.getDate()), month: String(now.getMonth() + 1), year: String(now.getFullYear()) };
}

/**
 * A date as three numeric boxes, Day, Month and Year, with "Today" and the caller's shortcuts (plan 1A Task 4, spec
 * 7.5). Controlled: the component shows `value` and never fills a box by itself, so an empty value stays empty.
 * Pure helpers for the boxes are lib/ui/dateParts.ts.
 */
export function DateField({
  idPrefix, legend, hint, value, onChange, error, required = false, shortcuts = [], showToday = false, errorId, disabled = false,
}: DateFieldProps): ReactElement {
  const hintId = given(hint) ? `${idPrefix}-hint` : undefined;
  const errorElementId = errorId ?? `${idPrefix}-error`;
  const describe = describedBy(hintId, given(error) ? errorElementId : undefined);
  return (
    <fieldset className="ui-date" disabled={disabled}>
      <legend className="ui-date__legend">
        {legend}
        {required ? <> <span className="ui-field__required">{UI_COPY.field.required}</span></> : null}
      </legend>
      {hintId === undefined ? null : <FieldHint id={hintId}>{hint}</FieldHint>}
      <div className="ui-date__parts">
        {PARTS.map((part) => (
          <div key={part} className={`ui-date__part ui-date__part--${part}`}>
            <label className="ui-date__label" htmlFor={`${idPrefix}-${part}`}>{UI_COPY.date[part]}</label>
            <input
              className={given(error) ? 'ui-input ui-input--invalid' : 'ui-input'} id={`${idPrefix}-${part}`} type="text"
              inputMode="numeric" autoComplete="off" maxLength={part === 'year' ? 4 : 2} value={value[part]}
              onChange={(e) => onChange({ ...value, [part]: e.target.value })}
              aria-invalid={given(error)} aria-describedby={describe}
            />
          </div>
        ))}
      </div>
      {showToday || shortcuts.length > 0 ? (
        <div className="ui-date__actions">
          {showToday ? <Button variant="secondary" size="compact" onClick={() => onChange(todayParts(new Date()))}>{UI_COPY.date.today}</Button> : null}
          {shortcuts.map((s) => (
            <Button key={s.label} variant="secondary" size="compact" onClick={() => onChange(s.value)}>{s.label}</Button>
          ))}
        </div>
      ) : null}
      {given(error) ? <FieldError id={errorElementId} message={error} /> : null}
    </fieldset>
  );
}
