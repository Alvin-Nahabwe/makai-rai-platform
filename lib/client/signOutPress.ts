import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';

/*
 * The one sign-out press of the pages that must not carry next-auth/react in their first visit (NFR-PERF-02): S-04, S-05
 * and the gate frame (S-29, S-07). Its failure path is here once: the press says `stillSignedIn` and never navigates. This
 * module imports next-auth only through the import() below, at the press.
 */

/** Where a sign-out press stands: not pressed, being carried out (until the browser leaves), or failed: still signed in, and said so. */
export type SignOutPhase = 'idle' | 'working' | 'stillSignedIn';

/** The sign-out module, loaded when a sign out is pressed (ruling T16-Q11); a test passes its own. */
export type LoadSignOut = () => Promise<Pick<typeof import('@/lib/client/signOutClearingDrafts'), 'signOutClearingDrafts'>>;

/**
 * NFR-PERF-02: the sign-out module (and next-auth/react with it) is not in S-04's first visit; it is loaded here, at
 * the press. Written as import() inside the function so the bundler splits it into its own chunk. S-05 and S-29
 * have no shell since plan 1B Task 1, so there it keeps next-auth/react out of their first visit too.
 */
const loadSignOutClearingDrafts: LoadSignOut = () => import('@/lib/client/signOutClearingDrafts');

/**
 * One sign-out press for the sign out controls of S-04, S-05 and the gate frame (rulings T16-Q11, T16-30): `show` hears `working`
 * first (which empties the failure line, so a second identical failure is announced again), then `stillSignedIn` if the load
 * or the sign-out itself rejects (T16-31). A press while one is working starts nothing: one load, one sign-out request.
 * Success leaves the phase at `working`, because the browser is leaving the page. There is no fallback: a press that
 * fails never navigates, so the account's drafts are removed only by signOutClearingDrafts (NFR-PRIV-06).
 */
export function signOutPress(load: LoadSignOut, show: (phase: SignOutPhase) => void): (userId: string, callbackUrl: string) => Promise<void> {
  let working = false;
  return async (userId, callbackUrl) => {
    if (working) return;
    working = true;
    try {
      show('working');
      const { signOutClearingDrafts } = await load();
      await signOutClearingDrafts(userId, callbackUrl);
    } catch (err: unknown) {
      // The person is still signed in and the line says so (ruling T16-31); the control is pressable again. The kind of
      // error is reported for whoever maintains this, never its message: the callbackUrl can hold an invitation token.
      console.warn('acceptances: a sign-out press was rejected', err instanceof Error ? err.name : typeof err);
      working = false;
      show('stillSignedIn');
    }
  };
}

/** The failure line's words for a phase: the ruled sentence once a press has failed, else nothing (the region stays, empty). */
export function signOutMessage(phase: SignOutPhase): string | null {
  return phase === 'stillSignedIn' ? ACCEPTANCES_COPY.stillSignedIn : null;
}

/** A sign out control's state and press, for S-04's M-24 button, S-05's link-styled button and the gate frame's Sign out alike (ruling T16-30). */
export function useSignOutPress(userId: string, callbackUrl: string): { busy: boolean; message: string | null; press: () => void } {
  const [phase, setPhase] = useState<SignOutPhase>('idle');
  const pressRef = useRef<ReturnType<typeof signOutPress> | null>(null);
  function press() {
    // `working` is committed at once, so the failure line is empty in the page before any later failure fills it again.
    pressRef.current ??= signOutPress(loadSignOutClearingDrafts, (next) => {
      if (next === 'working') flushSync(() => setPhase(next)); else setPhase(next);
    });
    void pressRef.current(userId, callbackUrl);
  }
  return { busy: phase === 'working', message: signOutMessage(phase), press };
}
