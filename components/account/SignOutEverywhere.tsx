'use client';

import { useState, type CSSProperties } from 'react';
import { signOut } from 'next-auth/react';
import { openDraftStore } from '@/lib/client/drafts';
import { clearLastProjects } from '@/lib/client/lastProject';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const NOT_DONE = 'Not done: the request did not reach the server, so your other sessions are still open. Try again.';

export type SignOutEverywhereState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'error'; message: string };

/**
 * Ends every session of the account (route 36, which raises its `sessionEpoch`), then signs this browser out as well
 * (FR-ACC-07). A 401 means only that this session had ended (its own 7-day limit, say) while the other sessions may live,
 * so it is not reported as done: this browser is signed out without leaving the page, and the page says to sign in again
 * and repeat (C4 ruling F1, owner copy). Any other failure leaves the other sessions open and says so, and signs nothing
 * out. Before each sign-out it makes, `purge` clears this account's drafts from this device (NFR-PRIV-06): the other
 * sessions end, and this browser's reason text must not outlive its session.
 */
const NOT_EVERYWHERE = 'Not signed out everywhere: you have been signed out of this browser. Sign in again and choose Sign out everywhere.';

export async function signOutEverywhere(
  fetchImpl: typeof fetch,
  signOutImpl: (o: { callbackUrl?: string; redirect?: boolean }) => Promise<unknown>,
  purge?: () => void,
): Promise<SignOutEverywhereState> {
  let res: Response;
  try {
    res = await fetchImpl('/api/users/me/sessions', { method: 'DELETE' });
  } catch {
    // fetch rejects only when no answer came back.
    return { kind: 'error', message: NOT_DONE };
  }
  if (res.status === 401) {
    purge?.();
    await signOutImpl({ redirect: false });
    return { kind: 'error', message: NOT_EVERYWHERE };
  }
  if (!res.ok) return { kind: 'error', message: NOT_DONE };
  purge?.();
  await signOutImpl({ callbackUrl: '/login' });
  return { kind: 'done' };
}

/** S-21's **Sign out everywhere** (W-12). */
export function SignOutEverywhere({ userId }: { userId: string }) {
  const [state, setState] = useState<SignOutEverywhereState>({ kind: 'idle' });
  async function onClick() {
    setState({ kind: 'sending' });
    setState(await signOutEverywhere(fetch, async (o) => {
      try {
        if (o.redirect === false) await signOut({ redirect: false });
        else await signOut({ callbackUrl: o.callbackUrl });
      } catch {
        // The sessions have already ended on the server; a plain navigation finishes this browser's sign-out.
        if (o.callbackUrl) window.location.assign(o.callbackUrl);
      }
    }, () => {
      openDraftStore()?.purgeAccount(userId);
      clearLastProjects(userId);
    }));
  }
  return (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClick} disabled={state.kind === 'sending'} style={TARGET}>Sign out everywhere</button>
      {' '}Ends every session, including this one.
      {state.kind === 'error' && <div role="alert" className="auth-error">{state.message}</div>}
    </>
  );
}
