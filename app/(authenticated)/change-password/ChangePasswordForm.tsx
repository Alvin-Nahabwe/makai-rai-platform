'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@/lib/validate';
import { useHydrated } from '@/lib/client/useHydrated';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const FIELD_ERROR: CSSProperties = { margin: 'var(--space-1) 0 0', color: 'var(--color-risk-critical)', fontSize: 'var(--font-size-sm)' };
const HINT: CSSProperties = { margin: 'var(--space-1) 0 0', fontSize: 'var(--font-size-sm)' };
const NOT_CHANGED = 'Not changed: the request did not reach the server. Your password is as it was; try again.';

export type ChangeState =
  | { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' }
  | { kind: 'invalid'; field: 'newPassword'; message: string } | { kind: 'error'; message: string };

/**
 * What route 35's answer means for the form: 200 done; a 422 under the new password; a refusal's own words (400, 401) at
 * the top; a failure on the server as such, with its support reference when the body carries one. Only a request that got
 * no answer at all says the password is as it was.
 */
export async function changePasswordOutcome(res: Response): Promise<ChangeState> {
  if (res.ok) return { kind: 'done' };
  const body = (await res.json().catch(() => null)) as { error?: string; reference?: string; fields?: Array<{ field: string; message: string }> } | null;
  const field = res.status === 422 ? body?.fields?.find((f) => f.field === 'newPassword') : undefined;
  if (field) return { kind: 'invalid', field: 'newPassword', message: field.message };
  if (res.status >= 500 || !body) {
    const ref = typeof body?.reference === 'string' ? ` (reference ${body.reference})` : '';
    return { kind: 'error', message: `The server had a problem${ref}. Try again.` };
  }
  return { kind: 'error', message: typeof body.error === 'string' && body.error.length > 0 ? body.error : `The server had a problem. Try again.` };
}

export interface ChangePasswordViewProps {
  currentPassword: string;
  newPassword: string;
  show: boolean;
  state: ChangeState;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onCurrent: (v: string) => void;
  onNew: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-29's form, which S-21's **Change password** opens too: the current password and one new one, no confirm field. */
export function ChangePasswordView(v: ChangePasswordViewProps) {
  const invalid = v.state.kind === 'invalid' ? v.state.message : null;
  const type = v.show ? 'text' : 'password';
  return (
    <>
      {v.state.kind === 'error' && <div className="auth-error" role="alert">{v.state.message}</div>}
      <form method="post" onSubmit={v.onSubmit} noValidate>
        <label htmlFor="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type={type} required autoComplete="current-password"
          value={v.currentPassword} onChange={(e) => v.onCurrent(e.currentTarget.value)} />
        <label htmlFor="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type={type} required autoComplete="new-password"
          value={v.newPassword} onChange={(e) => v.onNew(e.currentTarget.value)} aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? 'newPassword-hint newPassword-error' : 'newPassword-hint'} />
        <p id="newPassword-hint" style={HINT}>{`At least ${PASSWORD_MIN_LENGTH} characters.`}</p>
        {invalid && <p id="newPassword-error" style={FIELD_ERROR}>{invalid}</p>}
        <p>
          <button type="button" aria-controls="currentPassword newPassword" aria-pressed={v.show} onClick={v.onToggleShow}
            style={{ ...TARGET, padding: '0 var(--space-2)' }}>Show passwords</button>
        </p>
        <button type="submit" className="btn-primary" disabled={v.state.kind === 'sending' || v.hydrated === false} style={TARGET}>
          {v.state.kind === 'sending' ? 'Saving...' : 'Change password'}
        </button>
      </form>
    </>
  );
}

/** Posts route 35; on success every session has ended, so this browser signs out and S-01 says the password changed. */
export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [show, setShow] = useState(false);
  const [state, setState] = useState<ChangeState>({ kind: 'idle' });
  const hydrated = useHydrated();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'sending' });
    let next: ChangeState;
    try {
      next = await changePasswordOutcome(await fetch('/api/users/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      }));
    } catch {
      // fetch rejects only when no answer came back.
      next = { kind: 'error', message: NOT_CHANGED };
    }
    if (next.kind === 'done') {
      // This browser is signed out after a change, and the person signs straight back in as the same account (R-53).
      // The drafts belong to that account, so they are kept here, unlike the other person-started sign-outs. If another
      // account signs in next on this device, `purgeOtherAccounts` clears them (NFR-PRIV-06; controller ruling, 7 Nov 2026).
      try {
        await signOut({ callbackUrl: '/login?passwordChanged=1' });
      } catch {
        // The server has already ended every session, this one included, so S-01 is where this browser belongs.
        router.push('/login?passwordChanged=1');
      }
      return;
    }
    setState(next);
  }

  return (
    <ChangePasswordView currentPassword={currentPassword} newPassword={newPassword} show={show} state={state} hydrated={hydrated}
      onCurrent={setCurrentPassword} onNew={setNewPassword} onToggleShow={() => setShow((s) => !s)} onSubmit={onSubmit} />
  );
}
