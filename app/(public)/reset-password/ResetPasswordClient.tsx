'use client';

import { useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@/lib/validate';

/** M-22 (SRS 7.5.7): a used, expired, voided or unknown link, and a page opened with no link at all. */
const M22 = 'This link has expired or has already been used. Ask for a new one.';
const NOT_SET = 'Not set: the request did not reach the server. Your link still works; try again.';
const SERVER_PROBLEM = 'Not set: the server had a problem. Try again; if the link no longer works, ask for a new one.';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const FIELD_ERROR: CSSProperties = { margin: 'var(--space-1) 0 0', color: 'var(--color-risk-critical)', fontSize: 'var(--font-size-sm)' };
const HINT: CSSProperties = { margin: 'var(--space-1) 0 0', fontSize: 'var(--font-size-sm)' };

export type ResetState =
  | { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'unusable' }
  | { kind: 'invalid'; message: string } | { kind: 'error'; message: string };

type WindowLike = { location: { hash: string }; history: { replaceState: (data: unknown, unused: string, url: string) => void } };

/**
 * The token from E-03's link (`/reset-password#token=<64 hex>`), read once, and the address bar set back to
 * `/reset-password` before any request, so the token is never in a request line, a log, the history or a Referer
 * (NFR-OBS-01; obligation B9). Null when the page was opened without one.
 */
export function takeResetToken(win: WindowLike): string | null {
  const m = /^#token=([0-9a-f]{64})$/.exec(win.location.hash);
  if (win.location.hash) win.history.replaceState(null, '', '/reset-password');
  return m ? m[1] : null;
}

/** Sends the token and the new password in the body of route 34. */
export async function setNewPassword(fetchImpl: typeof fetch, token: string, newPassword: string): Promise<ResetState> {
  let res: Response;
  try {
    res = await fetchImpl('/api/password-reset/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
  } catch {
    // fetch rejects only when no answer came back; nothing was changed, and the link is unused.
    return { kind: 'error', message: NOT_SET };
  }
  if (res.status === 204) return { kind: 'done' };
  if (res.status === 410) return { kind: 'unusable' };
  if (res.status === 422) {
    // A 422 whose body cannot be read falls to the general message below, never to "password changed".
    const body = (await res.json().catch(() => null)) as { fields?: Array<{ field: string; message: string }> } | null;
    const field = body?.fields?.find((f) => f.field === 'newPassword');
    if (field) return { kind: 'invalid', message: field.message };
  }
  // The server answered, so whether the link was used is not known here.
  return { kind: 'error', message: SERVER_PROBLEM };
}

export interface ResetPasswordViewProps {
  token: string | null;
  password: string;
  showPassword: boolean;
  state: ResetState;
  onPassword: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-03's markup for a given state: one "New password" field (no confirm field), Show, and **Set password**. */
export function ResetPasswordView(v: ResetPasswordViewProps) {
  if (v.token === null || v.state.kind === 'unusable') {
    return (
      <>
        <div className="auth-error" role="alert">{M22}</div>
        <p className="auth-footer">
          <Link href="/forgot-password" style={{ display: 'inline-block', minHeight: '24px' }}>Ask for a new link</Link>
        </p>
      </>
    );
  }
  const invalid = v.state.kind === 'invalid' ? v.state.message : null;
  return (
    <>
      {v.state.kind === 'error' && <div className="auth-error" role="alert">{v.state.message}</div>}
      <form onSubmit={v.onSubmit} noValidate>
        <label htmlFor="new-password">New password</label>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <input id="new-password" name="new-password" type={v.showPassword ? 'text' : 'password'} required autoComplete="new-password"
            value={v.password} onChange={(e) => v.onPassword(e.currentTarget.value)} aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? 'new-password-hint new-password-error' : 'new-password-hint'} />
          <button type="button" aria-controls="new-password" aria-pressed={v.showPassword} onClick={v.onToggleShow}
            style={{ ...TARGET, padding: '0 var(--space-2)' }}>Show</button>
        </div>
        <p id="new-password-hint" style={HINT}>{`At least ${PASSWORD_MIN_LENGTH} characters.`}</p>
        {invalid && <p id="new-password-error" style={FIELD_ERROR}>{invalid}</p>}
        <button type="submit" className="btn-primary" disabled={v.state.kind === 'sending'} style={TARGET}>Set password</button>
      </form>
    </>
  );
}

/**
 * The token of the link this page was opened from, taken from the address once (takeResetToken clears the fragment, so a
 * later read finds none and keeps the last one taken). Read through useSyncExternalStore: the server, which never sees a
 * fragment, renders the loading state (`undefined`), and the browser's first render after hydration has the token. A
 * second link opened in the same tab changes only the fragment, which reloads nothing, so `hashchange` reads it again.
 */
let takenToken: string | null = null;
const tokenStore = {
  subscribe: (onChange: () => void) => {
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  },
  getSnapshot: (): string | null => {
    if (window.location.hash) takenToken = takeResetToken(window);
    return takenToken;
  },
  getServerSnapshot: (): undefined => undefined,
};

/** S-03: reads the link's token, then sets the password; success goes to S-01 with the changed notice. */
export function ResetPasswordClient() {
  const router = useRouter();
  const token = useSyncExternalStore<string | null | undefined>(tokenStore.subscribe, tokenStore.getSnapshot, tokenStore.getServerSnapshot);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<ResetState>({ kind: 'idle' });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    setState({ kind: 'sending' });
    const next = await setNewPassword(fetch, token, password);
    if (next.kind === 'done') {
      router.push('/login?passwordChanged=1');
      return;
    }
    setState(next);
  }

  if (token === undefined) return <p>Loading...</p>;
  return (
    <ResetPasswordView token={token} password={password} showPassword={showPassword} state={state}
      onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onSubmit={onSubmit} />
  );
}
