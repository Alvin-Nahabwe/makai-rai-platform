'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { M21 } from '@/lib/http/messages';

const NOT_SENT = 'Not sent: the request did not reach the server. Check the connection and try again.';
const SERVER_PROBLEM = 'Not sent: the server had a problem. Try again in a few minutes.';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };

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
    return res.status === 202 ? { kind: 'sent' } : { kind: 'error', message: SERVER_PROBLEM };
  } catch {
    // fetch rejects only when no answer came back (offline, a dropped connection).
    return { kind: 'error', message: NOT_SENT };
  }
}

export interface ForgotPasswordViewProps {
  email: string;
  state: ForgotState;
  onEmail: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-02's markup for a given state. */
export function ForgotPasswordView(v: ForgotPasswordViewProps) {
  return (
    <>
      {v.state.kind === 'sent' && <div className="auth-success" role="status">{M21}</div>}
      {v.state.kind === 'error' && <div className="auth-error" role="alert">{v.state.message}</div>}
      <form onSubmit={v.onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username" spellCheck={false}
          value={v.email} onChange={(e) => v.onEmail(e.currentTarget.value)} />
        <button type="submit" className="btn-primary" disabled={v.state.kind === 'sending'} style={TARGET}>Send reset link</button>
      </form>
    </>
  );
}

/** S-02: one email field and **Send reset link**, then M-21. */
export function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<ForgotState>({ kind: 'idle' });
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ kind: 'sending' });
    setState(await requestResetLink(fetch, email));
  }
  return <ForgotPasswordView email={email} state={state} onEmail={setEmail} onSubmit={onSubmit} />;
}
