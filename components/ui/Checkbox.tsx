import type { ChangeEventHandler, ReactElement, ReactNode } from 'react';
import { describedBy, FieldError, given } from '@/components/ui/TextInput';
import type { FieldOption } from '@/components/ui/types';
import './TextInput.css';
import './Checkbox.css';

export type CheckboxProps = {
  id: string;
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Pass `checked` (controlled, with `onChange`) or `defaultChecked`, never both. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  value?: string;
  error?: string;
  /** Marks the box invalid without an error of its own: CheckboxGroup sets it on every box while the group has an error. */
  invalid?: boolean;
};

/**
 * One checkbox and its label (plan 1A Task 4; modern-web-guidance checkbox): the native input drawn with
 * `appearance: none` in currentColor, so forced colours keep it, in a row 44 px high. The tick is a control state, not a
 * status mark.
 */
export function Checkbox({ id, name, label, hint, checked, defaultChecked, onChange, value, error, invalid = false }: CheckboxProps): ReactElement {
  const hintId = given(hint) ? `${id}-hint` : undefined;
  const errorId = `${id}-error`;
  return (
    <div className="ui-checkbox">
      <input
        type="checkbox" className="ui-checkbox__input" id={id} name={name} value={value} checked={checked}
        defaultChecked={defaultChecked} onChange={onChange}
        aria-invalid={invalid || given(error)} aria-describedby={describedBy(hintId, given(error) && errorId)}
      />
      <label className="ui-checkbox__label" htmlFor={id}>{label}</label>
      {hintId === undefined ? null : <div className="ui-checkbox__hint" id={hintId}>{hint}</div>}
      {given(error) ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}

export type CheckboxGroupProps = {
  name: string;
  legend: string;
  legendHint?: ReactNode;
  options: ReadonlyArray<FieldOption & { id?: string }>;
  /** Pass `values` (controlled, with `onChange`) or `defaultValues`, never both. */
  values?: readonly string[];
  defaultValues?: readonly string[];
  /** The checked values after a change, in the options' order; controlled values the options do not list are kept, last. */
  onChange?: (values: string[]) => void;
  error?: string;
  /** On the fieldset: it disables every checkbox. */
  disabled?: boolean;
  /** On the fieldset, after the legend hint and before the error. */
  'aria-describedby'?: string;
};

/**
 * The values checked after the box with `value` became `checked`, starting from `current`: the options' values in
 * their order, then any value of `current` the options do not list, in its order.
 */
function orderedValues(optionValues: readonly string[], current: readonly string[], value: string, checked: boolean): string[] {
  const chosen = new Set(current);
  if (checked) chosen.add(value);
  else chosen.delete(value);
  const listed = new Set(optionValues);
  return [...optionValues.filter((v) => chosen.has(v)), ...current.filter((v) => !listed.has(v) && chosen.has(v))];
}

/**
 * The values checked now. Controlled: the caller's values. Uncontrolled: the boxes the page shows checked in the box's
 * group (during the change event the box just changed already has its new state).
 */
function currentValues(values: readonly string[] | undefined, box: HTMLInputElement): readonly string[] {
  if (values !== undefined) return values;
  const group = box.closest('fieldset.ui-checkbox-group');
  if (group === null) throw new Error('CheckboxGroup: a box changed outside its group');
  return Array.from(group.querySelectorAll<HTMLInputElement>('.ui-checkbox__input:checked'), (b) => b.value);
}

/** A set of checkboxes under one legend, for "Which of these are in place?" (plan 1C). */
export function CheckboxGroup({
  name, legend, legendHint, options, values, defaultValues, onChange, error, disabled = false, 'aria-describedby': callerDescribedBy,
}: CheckboxGroupProps): ReactElement {
  const hintId = given(legendHint) ? `${name}-hint` : undefined;
  const errorId = `${name}-error`;
  const optionValues = options.map((o) => o.value);
  return (
    <fieldset className="ui-checkbox-group" disabled={disabled} aria-describedby={describedBy(hintId, callerDescribedBy, given(error) && errorId)}>
      <legend className="ui-checkbox-group__legend">{legend}</legend>
      {hintId === undefined ? null : <div className="ui-checkbox-group__hint" id={hintId}>{legendHint}</div>}
      {given(error) ? <FieldError id={errorId} message={error} /> : null}
      {options.map((o, index) => (
        <Checkbox
          key={o.value} id={o.id ?? `${name}-${index}`} name={name} value={o.value} label={o.label} hint={o.hint} invalid={given(error)}
          checked={values === undefined ? undefined : values.includes(o.value)}
          defaultChecked={values === undefined ? (defaultValues ?? []).includes(o.value) : undefined}
          onChange={onChange === undefined ? undefined : (e) => onChange(orderedValues(optionValues, currentValues(values, e.target), e.target.value, e.target.checked))}
        />
      ))}
    </fieldset>
  );
}
