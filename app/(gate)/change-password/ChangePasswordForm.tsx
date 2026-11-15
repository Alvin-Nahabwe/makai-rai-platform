'use client';

import { useState, type FormEvent } from 'react';
import { signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@/lib/validate';
import { CHANGE_PASSWORD_COPY } from '@/lib/auth/copy';
import { useHydrated } from '@/lib/client/useHydrated';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

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
    // An empty reference is no reference: it would print "...give this reference: ." (R1-6).
    const reference = typeof body?.reference === 'string' ? body.reference : '';
    return { kind: 'error', message: CHANGE_PASSWORD_COPY.serverProblem(reference || null) };
  }
  return { kind: 'error', message: typeof body.error === 'string' && body.error.length > 0 ? body.error : CHANGE_PASSWORD_COPY.serverProblem(null) };
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
      <StatusRegion message={v.state.kind === 'error' ? v.state.message : null} politeness="assertive" tone="error" />
      <form method="post" onSubmit={v.onSubmit} noValidate>
        <TextInput id="currentPassword" name="currentPassword" label={CHANGE_PASSWORD_COPY.currentPassword} type={type} required
          autoComplete="current-password" value={v.currentPassword} onChange={(e) => v.onCurrent(e.currentTarget.value)} />
        <TextInput id="newPassword" name="newPassword" label={CHANGE_PASSWORD_COPY.newPassword} type={type} required
          autoComplete="new-password" value={v.newPassword} onChange={(e) => v.onNew(e.currentTarget.value)}
          hint={CHANGE_PASSWORD_COPY.hint(PASSWORD_MIN_LENGTH)} error={invalid ?? undefined} />
        {/* The kit's Button cannot carry aria-pressed or aria-controls (ruling T16-5), so this is a native button in the kit's classes. */}
        <p style={{ margin: 'calc(-1 * var(--space-4)) 0 var(--space-6)' }}>
          <button type="button" className="ui-button ui-button--quiet ui-button--compact" aria-controls="currentPassword newPassword"
            aria-pressed={v.show} onClick={v.onToggleShow}>{CHANGE_PASSWORD_COPY.showPasswords}</button>
        </p>
        <Button variant="primary" type="submit" disabled={v.state.kind === 'sending' || v.hydrated === false}>
          {v.state.kind === 'sending' ? CHANGE_PASSWORD_COPY.submitting : CHANGE_PASSWORD_COPY.submit}
        </Button>
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
      next = { kind: 'error', message: CHANGE_PASSWORD_COPY.notChanged };
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
