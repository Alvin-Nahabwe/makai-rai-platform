import type { ChangeEventHandler, ReactElement, ReactNode } from 'react';
import { describedBy, FieldError, given } from '@/components/ui/TextInput';
import type { FieldOption } from '@/components/ui/types';
import './Checkbox.css';

export type CheckboxProps = {
  id: string;
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  value?: string;
  error?: string;
};

/**
 * One checkbox and its label (plan 1A Task 4; modern-web-guidance checkbox): the native input drawn with
 * `appearance: none` in currentColor, so forced colours keep it, in a row 44 px high. The tick is a control state, not a
 * status mark.
 */
export function Checkbox({ id, name, label, hint, checked, defaultChecked, onChange, value, error }: CheckboxProps): ReactElement {
  const hintId = given(hint) ? `${id}-hint` : undefined;
  const errorId = given(error) ? `${id}-error` : undefined;
  return (
    <div className="ui-checkbox">
      <input
        type="checkbox" className="ui-checkbox__input" id={id} name={name} value={value} checked={checked}
        defaultChecked={defaultChecked} onChange={onChange}
        aria-invalid={given(error)} aria-describedby={describedBy(hintId, errorId)}
      />
      <label className="ui-checkbox__label" htmlFor={id}>{label}</label>
      {hintId === undefined ? null : <div className="ui-checkbox__hint" id={hintId}>{hint}</div>}
      {errorId === undefined || error === undefined ? null : <FieldError id={errorId} message={error} />}
    </div>
  );
}

export type CheckboxGroupProps = {
  name: string;
  legend: string;
  legendHint?: ReactNode;
  options: ReadonlyArray<FieldOption & { id?: string }>;
  values?: readonly string[];
  defaultValues?: readonly string[];
  /** The checked values after a change: controlled, the given values with the changed one added last or removed. */
  onChange?: (values: string[]) => void;
  error?: string;
  /** On the fieldset: it disables every checkbox. */
  disabled?: boolean;
  /** On the fieldset, after the legend hint and before the error. */
  'aria-describedby'?: string;
};

/**
 * The values checked after one box changed. Controlled: the caller's values with that one added or removed, so a value
 * the options do not list is kept, not dropped. Uncontrolled: the boxes the page shows checked in the box's group, in
 * the options' order (during the change event the box just changed already has its new state).
 */
function nextValues(values: readonly string[] | undefined, box: HTMLInputElement): string[] {
  if (values !== undefined) return box.checked ? [...values.filter((v) => v !== box.value), box.value] : values.filter((v) => v !== box.value);
  const group = box.closest('fieldset.ui-checkbox-group');
  if (group === null) throw new Error('CheckboxGroup: a box changed outside its group');
  return Array.from(group.querySelectorAll<HTMLInputElement>('.ui-checkbox__input:checked'), (b) => b.value);
}

/** A set of checkboxes under one legend, for "Which of these are in place?" (plan 1C). */
export function CheckboxGroup({
  name, legend, legendHint, options, values, defaultValues, onChange, error, disabled = false, 'aria-describedby': callerDescribedBy,
}: CheckboxGroupProps): ReactElement {
  const hintId = given(legendHint) ? `${name}-hint` : undefined;
  const errorId = given(error) ? `${name}-error` : undefined;
  return (
    <fieldset className="ui-checkbox-group" disabled={disabled} aria-describedby={describedBy(hintId, callerDescribedBy, errorId)}>
      <legend className="ui-checkbox-group__legend">{legend}</legend>
      {hintId === undefined ? null : <div className="ui-checkbox-group__hint" id={hintId}>{legendHint}</div>}
      {errorId === undefined || error === undefined ? null : <FieldError id={errorId} message={error} />}
      {options.map((o, index) => (
        <Checkbox
          key={o.value} id={o.id ?? `${name}-${index}`} name={name} value={o.value} label={o.label} hint={o.hint}
          checked={values === undefined ? undefined : values.includes(o.value)}
          defaultChecked={values === undefined ? (defaultValues ?? []).includes(o.value) : undefined}
          onChange={onChange === undefined ? undefined : (e) => onChange(nextValues(values, e.target))}
        />
      ))}
    </fieldset>
  );
}
