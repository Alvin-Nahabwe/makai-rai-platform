'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getSession, signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { safeCallbackUrl } from '@/lib/safe-callback-url';
import { DRAFT_PREFIX, openDraftStore } from '@/lib/client/drafts';
import { LAST_PROJECT_PREFIX } from '@/lib/client/lastProject';
import { useSignOutPress } from '@/lib/client/signOutPress';
import { AUTH_COPY, AUTH_MESSAGE_COPY, SIGN_IN_COPY } from '@/lib/auth/copy';
import { SIGNED_OUT_HINT_KEY, tabStorage } from '@/lib/auth/idle';
import { useHydrated } from '@/lib/client/useHydrated';
import { AuthCard } from '@/components/auth/AuthCard';
import { createDoorStep, useDoorStep } from '@/components/auth/doorStep';
import { GateRoute, type GateStop } from '@/components/layout/GateRoute';
import { GATE_COPY } from '@/lib/shell/copy';
import { OtherAccountTextConfirm } from '@/components/auth/OtherAccountTextConfirm';
import { PasswordField } from '@/components/auth/PasswordField';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

/** Owner copy (C4 ruling SC-1): the admission's 503 `sign_in_busy` (lib/auth/signInAdmission.ts). */
export const SIGN_IN_BUSY = SIGN_IN_COPY.busy;
/** Owner copy (C4 ruling SC-1): any other failure on the server, a database outage included. */
export const SIGN_IN_SERVER_PROBLEM = SIGN_IN_COPY.serverProblem;
/** Owner copy (C4 ruling F2): no readable answer came back (a lost connection, or a gateway's HTML error page). */
export const SIGN_IN_CONNECTION_LOST = SIGN_IN_COPY.connectionLost;

/** The admission's 429 `rate_limited`, with the wait its url carries in `code`, in whole minutes rounded up. */
function rateLimitedText(code: string | null | undefined): string {
  const seconds = /^\d{1,5}$/.test(code ?? '') ? Number(code) : 60;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return SIGN_IN_COPY.rateLimited(minutes);
}

/**
 * The text S-01 shows for a sign-in that did not succeed. `next-auth/react`'s `signIn` reads `error` from the `url` of the
 * answer (node_modules/next-auth/react.js): `CredentialsSignin` for every refused credential (wrong password, locked,
 * unknown, deactivated: one text, M-20), or the admission's code. Any other code is next-auth's answer to a failure on
 * the server (a database outage gives `Configuration`, node_modules/@auth/core/index.js), which is not a refusal and is
 * not told as a wrong password; it says nothing about the account either way.
 */
export function signInErrorText(result: { error?: string | null; code?: string | null }): string {
  if (result.error === 'CredentialsSignin') return AUTH_MESSAGE_COPY.wrongCredentials;
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

/** What S-01 does after a sign-in that worked (D16): go on, or first ask about unsaved text another account left here. */
export type SignInNext = { kind: 'go' } | { kind: 'confirm'; who: 'other' | 'unknown' };

/**
 * D16, for a sign-in whose user id could not be read: whether this browser keeps any draft key at all. Storage that is
 * absent or refuses to list its keys keeps none this code can reach, so there is nothing to ask about (T5.5).
 */
export function anyDrafts(storage: Storage | null | undefined): boolean {
  const store = storage === undefined ? browserStorage() : storage;
  if (!store) return false;
  try {
    for (let i = 0; i < store.length; i++) {
      if (store.key(i)?.startsWith(DRAFT_PREFIX)) return true;
    }
    return false;
  } catch {
    // Refuses to list (a privacy mode): no draft can have been kept here either.
    return false;
  }
}

/**
 * D16 (T5.1, T5.4, T5.5): after a sign-in that worked, with the id the session read gave, whether to ask first. Only a
 * live draft of another account asks (one's own never does); with no id, any draft asks, as whose cannot be checked.
 * Storage that is absent or refuses access asks nothing, and the purge after it runs as today. Never a count.
 */
export function afterSignIn(storage: Storage | null | undefined, userId: string | null, now: Date): SignInNext {
  if (userId) return openDraftStore(storage)?.hasOtherAccounts(userId, now) ? { kind: 'confirm', who: 'other' } : { kind: 'go' };
  return anyDrafts(storage) ? { kind: 'confirm', who: 'unknown' } : { kind: 'go' };
}

/**
 * D16's Remove it and continue (T5.7, R4): the last-project keys of other accounts go with their drafts; this account's
 * stay. With no id, every last-project key goes, as every draft does. Each removal is tried on its own; one refused is
 * said once in fixed words (the key holds an id, which a log line may not), as clearLastProjects says it.
 */
export function removeOtherLastProjectKeys(storage: Storage | null | undefined, userId: string | null): void {
  const store = storage === undefined ? browserStorage() : storage;
  if (!store) return;
  const mine = userId ? `${LAST_PROJECT_PREFIX}${userId}:` : null;
  const others: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null && k.startsWith(LAST_PROJECT_PREFIX) && (mine === null || !k.startsWith(mine))) others.push(k);
    }
  } catch {
    // Refuses to list: nothing was written there by this code either, and the next project page tries again.
    return;
  }
  for (const k of others) {
    try {
      store.removeItem(k);
    } catch {
      console.warn('S-01: a last-project key of another account could not be removed after sign-in.');
    }
  }
}

/** Why the last session in this tab ended by the clock (C12), when S-01 knows it. */
export type SignedOutReason = 'idle' | 'absolute';

const HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The hint's text as one of the two words, or null; it has no path that throws (silent-failure review d2-sfh-1, finding 4). */
function decodeSignedOutHint(text: string, now: number): SignedOutReason | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // Not JSON: not a hint this code wrote, so there is no reason to show.
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { reason, at } = v as Record<string, unknown>;
  if (reason !== 'idle' && reason !== 'absolute') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const age = now - at;
  return age >= 0 && age <= HINT_MAX_AGE_MS ? reason : null;
}

/**
 * C12 (T2.1): why IdleWarning ended the last session in this tab, read once from `SIGNED_OUT_HINT_KEY` and removed. Only
 * the two fixed words come out, and only for a hint from the last 12 hours that is not in the future; anything else is
 * null and is removed too. Its value is never shown: S-01 shows its own sentence for the word. Each storage call is tried
 * on its own and a throw gives null, with no log, since most visits have no hint: a hint that cannot be removed is not
 * shown, so it cannot be shown twice.
 */
export function readSignedOutHint(storage: Storage | null, now: number): SignedOutReason | null {
  if (storage === null) return null;
  let text: string | null;
  try {
    text = storage.getItem(SIGNED_OUT_HINT_KEY);
  } catch {
    // Storage that refuses reads (a privacy mode): IdleWarning could not have written here either.
    return null;
  }
  if (text === null) return null;
  try {
    storage.removeItem(SIGNED_OUT_HINT_KEY);
  } catch {
    // Not removable: shown now, it would be shown again at every visit for 12 hours.
    return null;
  }
  return decodeSignedOutHint(text, now);
}

export interface LoginViewProps {
  email: string;
  password: string;
  showPassword: boolean;
  error: string;
  notice: string | null;
  loading: boolean;
  /** C12: why the last session in this tab ended, read after hydration (readSignedOutHint); null shows no line. */
  signedOut?: SignedOutReason | null;
  /** D16: signed in, and this browser keeps another account's unsaved text: the question shown in place of the form. */
  confirm?: { who: 'other' | 'unknown'; removing: boolean; leaving: boolean; message: string | null; onRemove: () => void; onSignOut: () => void } | null;
  /** False until React has hydrated; the submit button is disabled till then (default true for a static render). */
  hydrated?: boolean;
  onEmail: (v: string) => void;
  onPassword: (v: string) => void;
  onToggleShow: () => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

/**
 * S-01's markup for a given state (FR-ACC-05), in the gate frame's card (plan 1B Task 2): the heading; the signed-out line
 * when the last session in this tab ended by the clock; the success notice; the form, with the error line beside the
 * submit button (spec 9.7); then the footer. It offers no way to make an account: accounts come only from an invitation,
 * and the footer says so.
 */
export function LoginView(v: LoginViewProps) {
  if (v.confirm) {
    // Signed in already: only the question is left on this page (D16), as its heading (ruling L5-27), with no link away.
    return (
      <AuthCard title={v.confirm.who === 'other' ? AUTH_COPY.otherTextTitle : AUTH_COPY.unknownTextTitle}>
        <OtherAccountTextConfirm kind={v.confirm.who} removing={v.confirm.removing} leaving={v.confirm.leaving} message={v.confirm.message}
          onRemove={v.confirm.onRemove} onSignOut={v.confirm.onSignOut} />
      </AuthCard>
    );
  }
  const signedOut = v.signedOut ?? null;
  const lead = signedOut === null ? null : (
    <Banner kind="session">
      <p>{signedOut === 'idle' ? AUTH_COPY.signedOutIdle : AUTH_COPY.signedOutAbsolute} {AUTH_COPY.signedOutKept}</p>
    </Banner>
  );
  const footer = (
    <>
      <p><Link href="/forgot-password">{SIGN_IN_COPY.forgotLink}</Link></p>
      <p>{AUTH_COPY.noAccount}</p>
    </>
  );
  return (
    <AuthCard title={SIGN_IN_COPY.heading} lead={lead} footer={footer}>
      <StatusRegion message={v.notice} />
      <form method="post" onSubmit={v.onSubmit}>
        <TextInput id="email" name="email" label={SIGN_IN_COPY.email} type="email" required autoComplete="username" spellCheck={false}
          value={v.email} onChange={(e) => v.onEmail(e.currentTarget.value)} />
        <PasswordField id="password" name="password" label={SIGN_IN_COPY.password} autoComplete="current-password"
          value={v.password} onChange={(e) => v.onPassword(e.currentTarget.value)} show={v.showPassword} onToggleShow={v.onToggleShow} />
        <Button variant="primary" type="submit" disabled={v.loading || v.hydrated === false}>
          {v.loading ? SIGN_IN_COPY.submitting : SIGN_IN_COPY.submit}
        </Button>
        <StatusRegion message={v.error === '' ? null : v.error} politeness="assertive" tone="error" />
      </form>
    </AuthCard>
  );
}

/** S-01's step, for the frame's route (page.tsx renders LoginRoute beside the form): signing in, or D16's question. */
export const loginStep = createDoorStep<'signIn' | 'confirm'>('signIn');

const SIGN_IN_ROUTE: readonly GateStop[] = [{ label: GATE_COPY.stops.signIn, state: 'current' }];
/** While D16 asks, the sign-in has worked: Sign in is done and the question is where the person is (ruling L5-27). */
const QUESTION_ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.signIn, state: 'done' },
  { label: AUTH_COPY.loginStops.unsavedText, state: 'current' },
];

/** S-01's route for a given step. */
export function LoginRouteView({ step }: { step: 'signIn' | 'confirm' }) {
  return <GateRoute route={step === 'confirm' ? QUESTION_ROUTE : SIGN_IN_ROUTE} />;
}

/** S-01's route in the gate frame's column, following the form's step. */
export function LoginRoute() {
  return <LoginRouteView step={useDoorStep(loginStep)} />;
}

/** S-01: signs in through next-auth, then removes other accounts' drafts and goes to the page asked for. */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Defaults to `/`, the org dispatcher; a caller (the invitation page) may ask to come back. Validated same-origin.
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'));
  const notice = searchParams.get('passwordChanged') ? SIGN_IN_COPY.passwordChanged : searchParams.get('reason') === 'signed_out' ? SIGN_IN_COPY.signedOut : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [signedOut, setSignedOut] = useState<SignedOutReason | null>(null);
  const hintRead = useRef(false);
  const hydrated = useHydrated();
  // D16: the question after a sign-in that worked, with the id it read; and Remove it and continue being carried out.
  const [pending, setPending] = useState<{ who: 'other' | 'unknown'; userId: string | null } | null>(null);
  const [removing, setRemoving] = useState(false);
  // Sign out and leave it: S-05's press (lib/client/signOutPress.ts), which removes this account's own drafts only
  // (NFR-PRIV-06; T5.6) and, when the sign-out fails, says the person is still signed in and stays here.
  const leave = useSignOutPress(pending?.userId ?? '', '/login');
  // The frame's route follows the question, and goes back to Sign in when this form leaves the page.
  useEffect(() => { loginStep.set(pending === null ? 'signIn' : 'confirm'); }, [pending]);
  useEffect(() => () => loginStep.set('signIn'), []);

  // C12: the hint is read once, after hydration, so the server's render never depends on storage. The ref keeps a second
  // run of the effect (React's development double run) from reading the removed hint as none.
  useEffect(() => {
    if (hintRead.current) return;
    hintRead.current = true;
    setSignedOut(readSignedOutHint(tabStorage(), Date.now()));
  }, []);

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
    const next = afterSignIn(undefined, outcome.userId, new Date());
    if (next.kind === 'confirm') {
      setPending({ who: next.who, userId: outcome.userId });
      return;
    }
    goOn(outcome.userId);
  }

  /** Today's purge after a sign-in (T5.3: purgeOtherAccounts with the id, every draft without it), then the page asked for. */
  function goOn(userId: string | null) {
    try {
      purgeDraftsAfterSignIn(undefined, userId);
    } catch {
      // Without an id the purge lists storage with no guard of its own; storage that refuses it must not hold the person
      // on "Signing in..." once signed in (d2-sfh-1 finding 6). Nothing could be listed, so none was removed.
      console.warn('S-01: the drafts of this browser could not be listed after sign-in; none was removed');
    }
    router.push(callbackUrl);
  }

  function removeAndGoOn() {
    if (pending === null || removing) return;
    setRemoving(true);
    removeOtherLastProjectKeys(undefined, pending.userId);
    goOn(pending.userId);
  }

  return (
    <LoginView email={email} password={password} showPassword={showPassword} error={error} notice={notice} loading={loading} hydrated={hydrated}
      signedOut={signedOut}
      confirm={pending === null ? null : { who: pending.who, removing, leaving: leave.busy, message: leave.message, onRemove: removeAndGoOn, onSignOut: leave.press }}
      onEmail={setEmail} onPassword={setPassword} onToggleShow={() => setShowPassword((s) => !s)} onSubmit={onSubmit} />
  );
}
