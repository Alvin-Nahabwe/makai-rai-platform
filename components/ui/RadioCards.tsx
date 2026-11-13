import type { ReactElement, ReactNode } from 'react';
import { MarkShape } from '@/components/ui/StatusMark';
import { describedBy, FieldError, given } from '@/components/ui/TextInput';
import type { StatusMarkKind } from '@/components/ui/types';
import './TextInput.css';
import './RadioCards.css';

export type RadioCardsProps = {
  name: string;
  legend: string;
  /** Rendered after the legend, outside it, so the legend's text stays the group's name alone. */
  legendHint?: ReactNode;
  options: ReadonlyArray<{ value: string; label: string; help?: string; mark?: StatusMarkKind; id?: string }>;
  /** Pass `value` (controlled, with `onChange`) or `defaultValue`, never both. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  error?: string;
  /**
   * Native `required` on each radio. No marker is drawn: the legend holds its own text alone, so a caller that wants
   * the group to say it is required says so in `legendHint`.
   */
  required?: boolean;
  columns?: 1 | 2;
  /** On the fieldset: it disables every radio. */
  disabled?: boolean;
  /** On the fieldset, after the legend hint and before the error. */
  'aria-describedby'?: string;
};

/**
 * A choice of one, as cards (plan 1A Task 4, spec 7.5): the whole card selects, and the selection is a thicker border
 * in the selected colour plus the mark. The native radio stays for its semantics and its arrow keys, drawn in
 * currentColor.
 *
 * The radio's accessible name is exactly its option's `label`: the `<label>` holds only the radio, the mark (hidden from
 * assistive technology) and the label's words. The `help` sentence sits outside the label and describes the radio
 * (`aria-describedby`), and a click on it still reaches the radio through the label's stretched ::after. Protected
 * browser tests find a radio by `getByRole('radio', { name, exact: true })` (e2e/helpers/session.ts:147).
 */
export function RadioCards({
  name, legend, legendHint, options, value, defaultValue, onChange, error, required = false, columns = 1, disabled = false,
  'aria-describedby': callerDescribedBy,
}: RadioCardsProps): ReactElement {
  const hintId = given(legendHint) ? `${name}-hint` : undefined;
  const errorId = `${name}-error`;
  return (
    <fieldset
      className={columns === 2 ? 'ui-radio-cards ui-radio-cards--columns-2' : 'ui-radio-cards'} disabled={disabled}
      aria-describedby={describedBy(hintId, callerDescribedBy, given(error) && errorId)}
    >
      <legend className="ui-radio-cards__legend">{legend}</legend>
      {hintId === undefined ? null : <div className="ui-radio-cards__hint" id={hintId}>{legendHint}</div>}
      {given(error) ? <FieldError id={errorId} message={error} /> : null}
      <div className="ui-radio-cards__list">
        {options.map((o) => {
          const inputId = o.id ?? `${name}-${o.value}`;
          const helpId = o.help === undefined ? undefined : `${inputId}-help`;
          return (
            <div key={o.value} className="ui-radio-card">
              <label className="ui-radio-card__label" htmlFor={inputId}>
                <input
                  type="radio" className="ui-radio-card__input" id={inputId} name={name} value={o.value} required={required}
                  checked={value === undefined ? undefined : value === o.value}
                  defaultChecked={value === undefined ? defaultValue === o.value : undefined}
                  onChange={onChange === undefined ? undefined : () => onChange(o.value)}
                  aria-describedby={helpId}
                />
                {o.mark === undefined ? null : <MarkShape kind={o.mark} size={20} />}
                {o.label}
              </label>
              {helpId === undefined ? null : <p className="ui-radio-card__help" id={helpId}>{o.help}</p>}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
