'use client';

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { GATE_COPY } from '@/lib/shell/copy';

/** The sign-out module, loaded at the press, as S-05's own sign out loads it (ruling T16-Q11); a test passes its own. */
export type LoadGateSignOut = () => Promise<Pick<typeof import('@/lib/client/signOutClearingDrafts'), 'signOutClearingDrafts'>>;

/** Where a press stands: not pressed, being carried out (until the browser leaves), or failed: still signed in, and said so. */
export type GateSignOutPhase = 'idle' | 'working' | 'stillSignedIn';

const loadSignOutClearingDrafts: LoadGateSignOut = () => import('@/lib/client/signOutClearingDrafts');

/**
 * One press of the frame's Sign out, as S-05's sign out (signOutPress in components/legal/AcceptancesForm.tsx; rulings
 * T16-30, T16-31): `show` hears `working`, then this account's drafts and last-project keys are removed from this device and
 * the person is signed out to S-01 (signOutClearingDrafts, NFR-PRIV-06). A press while one is working starts nothing. If the
 * module cannot load or the sign-out rejects, `show` hears `stillSignedIn` and the button is pressable again. Nothing
 * navigates on a failure: a sign-out that went on without the purge would leave this account's drafts on the device.
 */
export function signOutFromGate(load: LoadGateSignOut, show: (phase: GateSignOutPhase) => void): (userId: string) => Promise<void> {
  let working = false;
  return async (userId) => {
    if (working) return;
    working = true;
    try {
      show('working');
      const { signOutClearingDrafts } = await load();
      await signOutClearingDrafts(userId, '/login');
    } catch (err: unknown) {
      // Still signed in, and the line says so. Only the kind of error is logged, never its message.
      console.warn('gate: a sign-out press was rejected', err instanceof Error ? err.name : typeof err);
      working = false;
      show('stillSignedIn');
    }
  };
}

/** The failure line's words for a phase: S-05's sentence once a press has failed, else nothing (the region stays, empty). */
export function signOutFailure(phase: GateSignOutPhase): string | null {
  return phase === 'stillSignedIn' ? ACCEPTANCES_COPY.stillSignedIn : null;
}

/**
 * The frame's Sign out (plan 1B Task 1). A form, so a press before hydration still signs out: it goes to next-auth's own
 * sign-out page (`GET /api/auth/signout`), which asks once more and posts with next-auth's CSRF token; no token is handled
 * here, and no script of this app runs there, so that path removes no draft (an idle sign-out does not either; the next
 * account's sign-in on this browser does, `purgeOtherAccounts`). Once hydrated, every press is caught and signOutFromGate
 * runs instead; a failure is said in the alert region under the button, which is in the page from the start. The button
 * wears the rail's Sign out class (app/globals.css) and says aria-busy while a press is carried out (it is not disabled).
 */
export function GateSignOut({ userId }: { userId: string }): ReactElement {
  const [phase, setPhase] = useState<GateSignOutPhase>('idle');
  const press = useRef<ReturnType<typeof signOutFromGate> | null>(null);
  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    // `working` is committed at once, so the failure line is empty in the page before a later failure fills it again.
    press.current ??= signOutFromGate(loadSignOutClearingDrafts, (next) => {
      if (next === 'working') flushSync(() => setPhase(next)); else setPhase(next);
    });
    void press.current(userId);
  }
  return (
    <form className="gate__signout" method="get" action="/api/auth/signout" onSubmit={onSubmit}>
      <input type="hidden" name="callbackUrl" value="/login" />
      <button type="submit" className="shell-rail__signout" aria-busy={phase === 'working' ? true : undefined}>
        <Icon name="log-out" />
        {GATE_COPY.signOut}
      </button>
      <StatusRegion politeness="assertive" tone="error" message={signOutFailure(phase)} />
    </form>
  );
}
