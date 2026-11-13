import type { ChangeEventHandler, ReactElement, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { describedBy, FieldError, FieldHint, FieldLabel, given } from '@/components/ui/TextInput';
import type { FieldOption } from '@/components/ui/types';
import './Select.css';

export type SelectProps = {
  id: string;
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  value?: string;
  defaultValue?: string;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  /** A first option with the empty value, for a select with nothing chosen yet. */
  placeholder?: string;
  options?: readonly FieldOption[];
  /** Options in labelled groups, after `options`. */
  groups?: ReadonlyArray<{ label: string; options: readonly FieldOption[] }>;
};

/** An option's words only: a native option holds text, so a FieldOption's `hint` is not shown here. */
const optionOf = (o: FieldOption) => <option key={o.value} value={o.value}>{o.label}</option>;

/**
 * A labelled select (plan 1A Task 4, decision B11): the closed control is styled (no native look, the chevron-down
 * icon), and where `appearance: base-select` is supported the picker is styled too; elsewhere the native picker opens.
 * `disabled` reaches the native select.
 */
export function Select({
  id, name, label, hint, error, required = false, disabled = false, value, defaultValue, onChange, placeholder, options = [], groups = [],
}: SelectProps): ReactElement {
  const hintId = given(hint) ? `${id}-hint` : undefined;
  const errorId = given(error) ? `${id}-error` : undefined;
  return (
    <div className="ui-field">
      <FieldLabel htmlFor={id} label={label} required={required} />
      {hintId === undefined ? null : <FieldHint id={hintId}>{hint}</FieldHint>}
      <div className="ui-select__wrap">
        <select
          className={given(error) ? 'ui-select ui-select--invalid' : 'ui-select'} id={id} name={name} required={required}
          disabled={disabled} value={value} defaultValue={defaultValue} onChange={onChange}
          aria-invalid={given(error)} aria-describedby={describedBy(hintId, errorId)}
        >
          {placeholder === undefined ? null : <option value="">{placeholder}</option>}
          {options.map(optionOf)}
          {groups.map((g) => <optgroup key={g.label} label={g.label}>{g.options.map(optionOf)}</optgroup>)}
        </select>
        <span className="ui-select__icon"><Icon name="chevron-down" size={20} /></span>
      </div>
      {errorId === undefined || error === undefined ? null : <FieldError id={errorId} message={error} />}
    </div>
  );
}
