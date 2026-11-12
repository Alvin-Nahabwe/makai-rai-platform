'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { getSession, signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { safeCallbackUrl } from '@/lib/safe-callback-url';
import { DRAFT_PREFIX, openDraftStore } from '@/lib/client/drafts';
import { M20 } from '@/lib/http/messages';
import { useHydrated } from '@/lib/client/useHydrated';

/** Owner copy (C4 ruling SC-1): the admission's 503 `sign_in_busy` (lib/auth/signInAdmission.ts). */
export const SIGN_IN_BUSY = 'Not signed in: the server is busy with other sign-ins. Nothing was changed. Try again in a minute.';
/** Owner copy (C4 ruling SC-1): any other failure on the server, a database outage included. */
export const SIGN_IN_SERVER_PROBLEM = 'Not signed in: the server had a problem. Nothing was changed. Try again in a few minutes.';
/** Owner copy (C4 ruling F2): no readable answer came back (a lost connection, or a gateway's HTML error page). */
export const SIGN_IN_CONNECTION_LOST = 'Not signed in: connection lost. Nothing was changed. Try again.';

/** The admission's 429 `rate_limited`, with the wait its url carries in `code`, in whole minutes rounded up. */
function rateLimitedText(code: string | null | undefined): string {
  const seconds = /^\d{1,5}$/.test(code ?? '') ? Number(code) : 60;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many sign-ins right now. Wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and try again.`;
}
const SIGNED_OUT = 'You are signed out. Sign in, then start the download again.';
const PASSWORD_CHANGED = 'Password changed. Please sign in with your new password.';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };

/**
 * The text S-01 shows for a sign-in that did not succeed. `next-auth/react`'s `signIn` reads `error` from the `url` of the
 * answer (node_modules/next-auth/react.js): `CredentialsSignin` for every refused credential (wrong password, locked,
 * unknown, deactivated: one text, M-20), or the admission's code. Any other code is next-auth's answer to a failure on
 * the server (a database outage gives `Configuration`, node_modules/@auth/core/index.js), which is not a refusal and is
 * not told as a wrong password; it says nothing about the account either way.
 */
export function signInErrorText(result: { error?: string | null; code?: string | null }): string {
  if (result.error === 'CredentialsSignin') return M20;
  if (result.error === 'rate_limited') return rateLimitedText(result.code);
  if (result.error === 'sign_in_busy') return SIGN_IN_BUSY;
  return SIGN_IN_SERVER_PROBLEM;
}

type SignInResult = { error?: string | null; code?: string | null } | undefined;
export interface SignInDeps {
  signIn: (provider: 'credentials', options: { email: string; password: string; redirect: false }) => Promise<SignInResult>;
  getSession: () => Promise<{ user?: { id?: string | null } | null } | null>;
}

/**
 * S-01's submit, apart from React: signs in, then reads the session's user id for the draft purge. A sign-in that gets no
 * readable answer (next-auth/react's `signIn` rejects on a lost connection or a non-JSON reply such as a gateway's 502
 * page) is told as such, so the form comes back instead of staying on "Signing in...". Once the sign-in has worked, a lost
 * session read does not undo it: the next page reads the session again, and only the purge is skipped.
 */
export async function submitSignIn(deps: SignInDeps, email: string, password: string): Promise<{ kind: 'done'; userId: string | null } | { kind: 'error'; message: string }> {
  let result: SignInResult;
  try {
    result = await deps.signIn('credentials', { email, password, redirect: false });
  } catch {
    return { kind: 'error', message: SIGN_IN_CONNECTION_LOST };
  }
  if (!result || result.error) return { kind: 'error', message: signInErrorText(result ?? {}) };
  // next-auth/react's getSession answers null when the read fails (a 429 from the session-read limit, a 5xx), so a null
  // is read once more. The catch is defensive only: getSession does not reject today.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const id = (await deps.getSession())?.user?.id;
      if (id) return { kind: 'done', userId: id };
    } catch {
      // read again, or fall through to no id
    }
  }
  return { kind: 'done', userId: null };
}

/**
 * UX-26 / B17 after a sign-in (C4 m3): with the account's id, the other accounts' drafts go. Without it (the session read
 * failed twice), the purge fails closed: every draft in this browser goes, this account's too, and one fixed line says
 * so for an operator. It never skips the purge. Returns how many drafts were removed.
 */
export function purgeDraftsAfterSignIn(storage: Storage | null | undefined, userId: string | null): number {
  if (userId) return purgeOtherAccountsAfterSignIn(storage, userId);
  console.warn('S-01: session read failed after sign-in; every draft on this browser was removed');
  const store = storage === undefined ? browserStorage() : storage;
  if (!store) return 0;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null && k.startsWith(DRAFT_PREFIX)) keys.push(k);
  }
  for (const k of keys) store.removeItem(k);
  return keys.length;
}

/** The browser's localStorage, or null where reading the property throws (blocked site data): no drafts are kept there. */
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
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
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
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
      <form method="post" onSubmit={v.onSubmit}>
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
        <button type="submit" className="btn-primary" disabled={v.loading || v.hydrated === false} style={TARGET}>
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
  const notice = searchParams.get('passwordChanged') ? PASSWORD_CHANGED : searchParams.get('reason') === 'signed_out' ? SIGNED_OUT : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const hydrated = useHydrated();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const outcome = await submitSignIn({ signIn, getSession }, email, password);
    if (outcome.kind === 'error') {
      setLoading(false);
      setError(outcome.message);
      return;
    }
    // undefined: the browser's own storage, and a blocked one reads as none (lib/client/drafts.ts).
    purgeDraftsAfterSignIn(undefined, outcome.userId);
    router.push(callbackUrl);
  }

  return (
    <LoginView email={email} password={password} showPassword={showPassword} error={error} notice={notice} loading={loading} hydrated={hydrated}
      onEmail={setEmail} onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onSubmit={onSubmit} />
  );
}
