'use client';

import { useState, type CSSProperties } from 'react';
import { signOut } from 'next-auth/react';

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px' };
const NOT_DONE = 'Not done: the request did not reach the server, so your other sessions are still open. Try again.';

export type SignOutEverywhereState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done' } | { kind: 'error'; message: string };

/**
 * Ends every session of the account (route 36, which raises its `sessionEpoch`), then signs this browser out as well
 * (FR-ACC-07). A 401 means this session had already ended, so the browser is signed out all the same; any other failure
 * leaves the other sessions open and says so, and signs nothing out.
 */
export async function signOutEverywhere(
  fetchImpl: typeof fetch,
  signOutImpl: (o: { callbackUrl: string }) => Promise<unknown>,
): Promise<SignOutEverywhereState> {
  let res: Response;
  try {
    res = await fetchImpl('/api/users/me/sessions', { method: 'DELETE' });
  } catch {
    // fetch rejects only when no answer came back.
    return { kind: 'error', message: NOT_DONE };
  }
  if (!res.ok && res.status !== 401) return { kind: 'error', message: NOT_DONE };
  await signOutImpl({ callbackUrl: '/login' });
  return { kind: 'done' };
}

/** S-21's **Sign out everywhere** (W-12). */
export function SignOutEverywhere() {
  const [state, setState] = useState<SignOutEverywhereState>({ kind: 'idle' });
  async function onClick() {
    setState({ kind: 'sending' });
    setState(await signOutEverywhere(fetch, async (o) => {
      try {
        await signOut(o);
      } catch {
        // The sessions have already ended on the server; a plain navigation finishes this browser's sign-out.
        window.location.assign(o.callbackUrl);
      }
    }));
  }
  return (
    <>
      <button type="button" className="btn btn--secondary" onClick={onClick} disabled={state.kind === 'sending'} style={TARGET}>Sign out everywhere</button>
      {' '}Ends every session, including this one.
      {state.kind === 'error' && <p role="alert" className="auth-error">{state.message}</p>}
    </>
  );
}
