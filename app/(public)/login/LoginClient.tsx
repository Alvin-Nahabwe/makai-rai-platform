'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { getSession, signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { safeCallbackUrl } from '@/lib/safe-callback-url';
import { openDraftStore } from '@/lib/client/drafts';

/** M-20 (SRS 7.5.7): one text for a wrong password, a locked account and an unknown email (FR-ACC-05). */
const M20 = 'The email or password is not right, or the account is locked after too many attempts. Try again in 15 minutes, or reset your password.';
/** M-07 (SRS 7.5.7): the admission's 503 `sign_in_busy` (lib/auth/signInAdmission.ts). */
const M07 = 'Not saved: the server had a problem. Your answer is kept on this device. Retry.';
/** The admission's 429 `rate_limited`: its ceiling counts a fixed minute, so the wait is at most one. */
const RATE_LIMITED = 'Too many sign-ins right now. Wait 1 minute and try again.';
const PASSWORD_CHANGED = 'Password changed. Please sign in with your new password.';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };

/**
 * The text S-01 shows for a refused sign-in. `next-auth/react`'s `signIn` reads `error` from the `url` of the answer
 * (node_modules/next-auth/react.js): `CredentialsSignin` for any refused credentials, or the admission's code. Anything
 * else is a refusal too, so it gets M-20, never a hint about which case it was.
 */
export function signInErrorText(result: { error?: string | null }): string {
  if (result.error === 'sign_in_busy') return M07;
  if (result.error === 'rate_limited') return RATE_LIMITED;
  return M20;
}

/**
 * UX-26: after a sign-in, drafts another account left in this browser are removed, so a shared computer does not show
 * one person's unsaved text to the next. A browser that keeps no storage signs in all the same.
 */
export function purgeOtherAccountsAfterSignIn(storage: Storage | null | undefined, userId: string): number {
  return openDraftStore(storage)?.purgeOtherAccounts(userId) ?? 0;
}

export interface LoginViewProps {
  email: string;
  password: string;
  showPassword: boolean;
  error: string;
  notice: string | null;
  loading: boolean;
  onEmail: (v: string) => void;
  onPassword: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/** S-01's markup for a given state (FR-ACC-05). It offers no way to make an account: accounts come only from an invitation. */
export function LoginView(v: LoginViewProps) {
  return (
    <>
      <h1>Sign In</h1>
      {v.notice && <div className="auth-success" role="status">{v.notice}</div>}
      {v.error && <div className="auth-error" role="alert">{v.error}</div>}
      <form onSubmit={v.onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required autoComplete="username" spellCheck={false}
          value={v.email} onChange={(e) => v.onEmail(e.currentTarget.value)} />
        <label htmlFor="password">Password</label>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <input id="password" name="password" type={v.showPassword ? 'text' : 'password'} required autoComplete="current-password"
            value={v.password} onChange={(e) => v.onPassword(e.currentTarget.value)} />
          <button type="button" aria-controls="password" aria-pressed={v.showPassword} onClick={v.onToggleShow}
            style={{ ...TARGET, padding: '0 var(--space-2)' }}>Show</button>
        </div>
        <button type="submit" className="btn-primary" disabled={v.loading} style={TARGET}>
          {v.loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
      <p className="auth-footer">
        <Link href="/forgot-password" style={{ display: 'inline-block', minHeight: '24px' }}>Forgot your password?</Link>
      </p>
    </>
  );
}

/** S-01: signs in through next-auth, then removes other accounts' drafts and goes to the page asked for. */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Defaults to `/`, the org dispatcher; a caller (the invitation page) may ask to come back. Validated same-origin.
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'));
  const notice = searchParams.get('passwordChanged') ? PASSWORD_CHANGED : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await signIn('credentials', { email, password, redirect: false });
    if (!result || result.error) {
      setLoading(false);
      setError(signInErrorText(result ?? {}));
      return;
    }
    const session = await getSession();
    const userId = session?.user?.id;
    // undefined: the store opens the browser's own storage, and a blocked one reads as none (lib/client/drafts.ts).
    if (userId) purgeOtherAccountsAfterSignIn(undefined, userId);
    router.push(callbackUrl);
  }

  return (
    <LoginView email={email} password={password} showPassword={showPassword} error={error} notice={notice} loading={loading}
      onEmail={setEmail} onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onSubmit={onSubmit} />
  );
}
