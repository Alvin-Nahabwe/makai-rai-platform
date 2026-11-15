'use client';

import { useState, type ChangeEventHandler, type ReactElement, type ReactNode, type Ref } from 'react';
import { TextInput } from '@/components/ui/TextInput';
import { AUTH_COPY } from '@/lib/auth/copy';
import './auth.css';

export type PasswordFieldProps = {
  id: string;
  name: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  hint?: ReactNode;
  error?: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  ref?: Ref<HTMLInputElement>;
  /** Shown or hidden, when the caller holds it (a view rendered for a given state); otherwise the field holds it. */
  show?: boolean;
  onToggleShow?: () => void;
};

/**
 * A password box (plan 1B Task 2): the kit's TextInput with `type="password"`, and a **Show password** toggle under it
 * (modern-web-guidance autofill-sign-in-form: "add a Show password toggle"). The toggle is a native button that says
 * aria-pressed and names the box it controls (the kit's Button cannot carry either, ruling T16-5). Its label stays "Show
 * password" in both states: aria-pressed already says which, and a label that changed too would say it twice. Pasting
 * is never blocked (NFR-A11Y-04), and `required` lets the browser stop an empty submit.
 */
export function PasswordField({ id, name, label, autoComplete, hint, error, value, onChange, ref, show, onToggleShow }: PasswordFieldProps): ReactElement {
  const [ownShow, setOwnShow] = useState(false);
  const shown = show ?? ownShow;
  const toggle = onToggleShow ?? (() => setOwnShow((s) => !s));
  return (
    <div className="password-field">
      <TextInput id={id} name={name} label={label} type={shown ? 'text' : 'password'} required autoComplete={autoComplete}
        value={value} onChange={onChange} hint={hint} error={error} ref={ref} />
      <p className="password-field__toggle">
        <button type="button" className="ui-button ui-button--quiet ui-button--compact" aria-controls={id} aria-pressed={shown} onClick={toggle}>{AUTH_COPY.showPassword}</button>
      </p>
    </div>
  );
}
