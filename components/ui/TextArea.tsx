import type { ChangeEventHandler, ReactElement, Ref } from 'react';
import { describedBy, FieldError, FieldHint, FieldLabel, given, type TextInputProps } from '@/components/ui/TextInput';
import './TextInput.css';
import './TextArea.css';

export type TextAreaProps = Omit<TextInputProps, 'type' | 'maxLength' | 'onChange' | 'ref' | 'value' | 'defaultValue'> & {
  /**
   * Controlled only: the count measures `value`, so it follows the typing only when the caller holds the text. Pass
   * `onChange`, or `readOnly` (React warns about a controlled area with neither) or `disabled`.
   */
  value: string;
  rows?: number;
  /** The limit the count measures against. Not set on the textarea: text over the limit stays, and the count says so. */
  maxLength: number;
  /** The count's words for `n` characters of `max`, for example "120 of 4,000 characters". */
  count: (n: number, max: number) => string;
  /** Further ids that describe the textarea, read after the count and before the error. */
  describedBy?: readonly string[];
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  ref?: Ref<HTMLTextAreaElement>;
};

/**
 * A labelled text area with a count (plan 1A Task 4, spec 7.5). The count is plain text, not a live region: a count
 * announced on every keystroke would talk over the typing. Past the limit it takes `--over` and the caller's sentence.
 * Characters are code points, so an emoji counts once, as the 4,000 limit is measured (lib/decision/rules.ts
 * reasonLength).
 */
export function TextArea({
  id, name, label, hint, error, required = false, autoComplete, inputMode, value, onChange, rows = 5, maxLength, count,
  describedBy: extra = [], width = 'full', disabled = false, readOnly = false, spellCheck, ref,
}: TextAreaProps): ReactElement {
  const hintId = given(hint) ? `${id}-hint` : undefined;
  const countId = `${id}-count`;
  const errorId = `${id}-error`;
  const n = Array.from(value).length;
  const className = ['ui-textarea', width !== 'full' && `ui-textarea--${width}`, given(error) && 'ui-textarea--invalid', readOnly && 'ui-textarea--readonly']
    .filter(Boolean).join(' ');
  return (
    <div className="ui-field">
      <FieldLabel htmlFor={id} label={label} required={required} />
      {hintId === undefined ? null : <FieldHint id={hintId}>{hint}</FieldHint>}
      <textarea
        ref={ref} className={className} id={id} name={name} rows={rows} required={required} autoComplete={autoComplete}
        inputMode={inputMode} value={value} onChange={onChange} disabled={disabled} readOnly={readOnly} spellCheck={spellCheck}
        aria-invalid={given(error)} aria-describedby={describedBy(hintId, countId, ...extra, given(error) && errorId)}
      />
      <p className={n > maxLength ? 'ui-count ui-count--over' : 'ui-count'} id={countId}>{count(n, maxLength)}</p>
      {given(error) ? <FieldError id={errorId} message={error} /> : null}
    </div>
  );
}
