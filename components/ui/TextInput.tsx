import type { ChangeEventHandler, HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { Icon } from '@/components/ui/Icon';
import { UI_COPY } from '@/lib/ui/copy';
import './TextInput.css';

/**
 * A labelled text box (plan 1A Task 4), and the field parts every form control of the kit shares: the label, the hint
 * above the control, and the error below it (decision B5: ink, bold, the triangle-alert icon, never red).
 *
 * The error is the caller's: it is shown when the caller passes `error`, which a form does after a submit or after the
 * person leaves the field (modern-web-guidance validate-input-after-interaction), never while the person is typing.
 */

export type TextInputProps = {
  id: string;
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  type?: 'text' | 'email' | 'password' | 'url' | 'search';
  required?: boolean;
  /** Passed through as given (a password field names `current-password` or `new-password`). */
  autoComplete?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  value?: string;
  defaultValue?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  maxLength?: number;
  width?: 'full' | 'medium' | 'short';
  disabled?: boolean;
  /** Focusable and submitted, drawn as a tint with no control border. */
  readOnly?: boolean;
  spellCheck?: boolean;
  ref?: Ref<HTMLInputElement>;
};

/**
 * Whether a hint or an error was given: `undefined`, `null`, `false` and the empty string are not, so a caller's
 * `hint={cond && text}` or `error={message ?? ''}` draws no empty hint or error and points no description at one.
 */
export function given<T>(node: T | null | undefined | false): node is T {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/** The ids an `aria-describedby` lists, in order, skipping the absent ones; undefined when there are none. */
export function describedBy(...ids: ReadonlyArray<string | false | null | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length === 0 ? undefined : present.join(' ');
}

/** A field's label; a required field says so in words after it ("Reason (required)"). */
export function FieldLabel({ htmlFor, label, required = false, className = 'ui-field__label' }: { htmlFor: string; label: ReactNode; required?: boolean; className?: string }): ReactElement {
  return (
    <label className={className} htmlFor={htmlFor}>
      {label}
      {required ? <> <span className="ui-field__required">{UI_COPY.field.required}</span></> : null}
    </label>
  );
}

/** A field's hint, above its control. */
export function FieldHint({ id, children }: { id: string; children: ReactNode }): ReactElement {
  return <div className="ui-field__hint" id={id}>{children}</div>;
}

/**
 * A field's error (B5): the triangle-alert icon, hidden from assistive technology, then the visually hidden word
 * "Error:" so a screen reader hears what the icon shows, then the message.
 */
export function FieldError({ id, message }: { id: string; message: string }): ReactElement {
  return (
    <p className="ui-field__error" id={id}>
      <Icon name="triangle-alert" size={20} />
      <span><span className="visually-hidden">{UI_COPY.field.errorPrefix} </span>{message}</span>
    </p>
  );
}

export function TextInput({
  id, name, label, hint, error, type = 'text', required = false, autoComplete, inputMode, value, defaultValue, onChange,
  maxLength, width = 'full', disabled = false, readOnly = false, spellCheck, ref,
}: TextInputProps): ReactElement {
  const hintId = given(hint) ? `${id}-hint` : undefined;
  const errorId = given(error) ? `${id}-error` : undefined;
  const className = ['ui-input', width !== 'full' && `ui-input--${width}`, given(error) && 'ui-input--invalid', readOnly && 'ui-input--readonly']
    .filter(Boolean).join(' ');
  return (
    <div className="ui-field">
      <FieldLabel htmlFor={id} label={label} required={required} />
      {hintId === undefined ? null : <FieldHint id={hintId}>{hint}</FieldHint>}
      <input
        ref={ref} className={className} id={id} name={name} type={type} required={required} autoComplete={autoComplete}
        inputMode={inputMode} value={value} defaultValue={defaultValue} onChange={onChange} maxLength={maxLength}
        disabled={disabled} readOnly={readOnly} spellCheck={spellCheck}
        aria-invalid={given(error)} aria-describedby={describedBy(hintId, errorId)}
      />
      {errorId === undefined || error === undefined ? null : <FieldError id={errorId} message={error} />}
    </div>
  );
}
