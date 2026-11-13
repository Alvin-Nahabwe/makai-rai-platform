'use client';

import { useState, useSyncExternalStore, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@/lib/validate';
import { AUTH_MESSAGE_COPY, RESET_COPY } from '@/lib/auth/copy';
import { useHydrated } from '@/lib/client/useHydrated';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

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
    return { kind: 'error', message: RESET_COPY.notReached };
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
  return { kind: 'error', message: RESET_COPY.serverProblem };
}

export interface ResetPasswordViewProps {
  token: string | null;
  password: string;
  showPassword: boolean;
  state: ResetState;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onPassword: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-03's markup for a given state: one "New password" field (no confirm field), Show, and **Set password**. */
export function ResetPasswordView(v: ResetPasswordViewProps) {
  // Checked before the token: the token is forgotten once the password is set, and that must not read as a dead link.
  if (v.state.kind === 'done') return <StatusRegion message={RESET_COPY.passwordChanged} />;
  if (v.token === null || v.state.kind === 'unusable') {
    return (
      <>
        <StatusRegion message={AUTH_MESSAGE_COPY.resetLinkUnusable} politeness="assertive" tone="error" />
        <p className="auth-footer">
          <Link href="/forgot-password" style={{ display: 'inline-block', minHeight: '24px' }}>{RESET_COPY.askNewLink}</Link>
        </p>
      </>
    );
  }
  const invalid = v.state.kind === 'invalid' ? v.state.message : null;
  return (
    <>
      <StatusRegion message={v.state.kind === 'error' ? v.state.message : null} politeness="assertive" tone="error" />
      <form method="post" onSubmit={v.onSubmit} noValidate>
        <TextInput id="new-password" name="new-password" label={RESET_COPY.newPassword} type={v.showPassword ? 'text' : 'password'} required
          autoComplete="new-password" value={v.password} onChange={(e) => v.onPassword(e.currentTarget.value)}
          hint={RESET_COPY.hint(PASSWORD_MIN_LENGTH)} error={invalid ?? undefined} />
        {/* The kit's Button cannot carry aria-pressed or aria-controls (ruling T16-5), so this is a native button in the kit's classes. */}
        <p style={{ margin: 'calc(-1 * var(--space-4)) 0 var(--space-6)' }}>
          <button type="button" className="ui-button ui-button--quiet ui-button--compact" aria-controls="new-password"
            aria-pressed={v.showPassword} onClick={v.onToggleShow}>{RESET_COPY.showPassword}</button>
        </p>
        <Button variant="primary" type="submit" disabled={v.state.kind === 'sending' || v.hydrated === false}>{RESET_COPY.submit}</Button>
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
export const resetTokenStore = {
  subscribe: (onChange: () => void) => {
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  },
  getSnapshot: (): string | null => {
    if (window.location.hash) takenToken = takeResetToken(window);
    return takenToken;
  },
  getServerSnapshot: (): undefined => undefined,
  /** After the link was used or refused: a later visit without a link shows M-22, never the old token (C4 CR-6). */
  forget: (): void => {
    takenToken = null;
  },
};

/** S-03: reads the link's token, then sets the password; success goes to S-01 with the changed notice. */
export function ResetPasswordClient() {
  const router = useRouter();
  const token = useSyncExternalStore<string | null | undefined>(resetTokenStore.subscribe, resetTokenStore.getSnapshot, resetTokenStore.getServerSnapshot);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState<ResetState>({ kind: 'idle' });
  const hydrated = useHydrated();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    setState({ kind: 'sending' });
    const next = await setNewPassword(fetch, token, password);
    // The state first, then the token is forgotten (C4 m4): a render in between shows the done notice, never M-22.
    setState(next);
    if (next.kind === 'done' || next.kind === 'unusable') resetTokenStore.forget();
    if (next.kind === 'done') router.push('/login?passwordChanged=1');
  }

  if (token === undefined) return <p>{RESET_COPY.loading}</p>;
  return (
    <ResetPasswordView token={token} password={password} showPassword={showPassword} state={state} hydrated={hydrated}
      onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onSubmit={onSubmit} />
  );
}
