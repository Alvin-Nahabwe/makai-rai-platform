'use client';

import { useState, type FormEvent } from 'react';
import { AUTH_MESSAGE_COPY, FORGOT_COPY } from '@/lib/auth/copy';
import { useHydrated } from '@/lib/client/useHydrated';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

export type ForgotState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * Asks route 33 for a reset link. Its answer is the same 202 for every address, so any 202 is "sent"; a lost connection
 * or another answer is an error the person can retry, with the address kept, each said as what it is.
 */
export async function requestResetLink(fetchImpl: typeof fetch, email: string): Promise<ForgotState> {
  try {
    const res = await fetchImpl('/api/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.status === 202 ? { kind: 'sent' } : { kind: 'error', message: FORGOT_COPY.serverProblem };
  } catch {
    // fetch rejects only when no answer came back (offline, a dropped connection).
    return { kind: 'error', message: FORGOT_COPY.notReached };
  }
}

export interface ForgotPasswordViewProps {
  email: string;
  state: ForgotState;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onEmail: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-02's markup for a given state. */
export function ForgotPasswordView(v: ForgotPasswordViewProps) {
  return (
    <>
      <StatusRegion message={v.state.kind === 'sent' ? AUTH_MESSAGE_COPY.resetLinkSent : null} />
      <StatusRegion message={v.state.kind === 'error' ? v.state.message : null} politeness="assertive" tone="error" />
      <form method="post" onSubmit={v.onSubmit}>
        <TextInput id="email" name="email" label={FORGOT_COPY.email} type="email" required autoComplete="username" spellCheck={false}
          value={v.email} onChange={(e) => v.onEmail(e.currentTarget.value)} />
        <Button variant="primary" type="submit" disabled={v.state.kind === 'sending' || v.hydrated === false}>{FORGOT_COPY.submit}</Button>
      </form>
    </>
  );
}

/** S-02: one email field and **Send reset link**, then M-21. */
export function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<ForgotState>({ kind: 'idle' });
  const hydrated = useHydrated();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'sending' });
    setState(await requestResetLink(fetch, email));
  }
  return <ForgotPasswordView email={email} state={state} hydrated={hydrated} onEmail={setEmail} onSubmit={onSubmit} />;
}
