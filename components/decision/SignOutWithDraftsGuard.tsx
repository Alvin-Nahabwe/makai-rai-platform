'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { signOutClearingDrafts } from '@/lib/client/signOutClearingDrafts';
import type { SignOutPhase } from '@/lib/client/signOutPress';
import { Button } from '@/components/ui/Button';
import '@/components/ui/buttonStyles';
import { openDraftStore } from '@/lib/client/drafts';
import { DRAFTS_COPY } from '@/lib/decision/drafts/copy';
import { clearLastProjects } from '@/lib/client/lastProject';

export type SignOutWithDraftsGuardProps = {
  userId: string;
  children: ReactNode;
  /** Hears `working` when Delete them and sign out starts and `stillSignedIn` when the sign-out is refused (the rail's status line speaks it). */
  onPhase?: (phase: SignOutPhase) => void;
};

/**
 * Deletes this account's drafts and last-project keys, then signs out. True when the sign-out went on (the browser is
 * leaving); false when it was refused (signOutClearingDrafts rejected: no navigation, still signed in), reported to
 * `onPhase` as `stillSignedIn`. The drafts are already gone by then (M-41).
 */
export async function deleteDraftsAndSignOut(userId: string, onPhase?: (phase: SignOutPhase) => void): Promise<boolean> {
  onPhase?.('working');
  openDraftStore()?.purgeAccount(userId);
  clearLastProjects(userId);
  try {
    await signOutClearingDrafts(userId, '/login');
    return true;
  } catch (err: unknown) {
    console.warn('drafts guard: a sign-out press was rejected', err instanceof Error ? err.name : typeof err);
    onPhase?.('stillSignedIn');
    return false;
  }
}

/** M-41 (SRS 7.5.7), without its two bracketed actions, which are the buttons below it (answer Q11). */
export const m41 = (n: number): string => DRAFTS_COPY.signOut.warning(n);

/**
 * The guard around the sidebar's Sign out button (M-41, UX-26, NFR-PRIV-06, FR-DEC-06). A press is caught before the
 * button's own handler runs: when this device holds drafts of this account, M-41 shows instead, with **Go to them**
 * (S-21's drafts list) and **Delete them and sign out**, which deletes this account's drafts and then signs out. With
 * no draft, or no storage, the press goes through to the button unchanged.
 *
 * The sign-outs a person starts purge this account's drafts: this guard, account deletion, sign out everywhere, the S-05
 * sign out and the S-04 sign outs (NFR-PRIV-06). Change password keeps them, as the session continues. An idle sign-out
 * runs no client code, so it keeps them (R-53, SRS line 5907), and the next account's sign-in removes them (ACC-b's
 * `purgeOtherAccounts`).
 */
export function SignOutWithDraftsGuard({ userId, children, onPhase }: SignOutWithDraftsGuardProps): ReactElement {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // An alert dialog takes focus when it opens, so a keyboard or screen-reader user is at the warning, not behind it.
  const warning = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (count !== null) warning.current?.focus(); }, [count]);

  function onClickCapture(e: MouseEvent<HTMLSpanElement>): void {
    const n = openDraftStore()?.count(userId, new Date()) ?? 0;
    if (n === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setCount(n);
  }

  async function deleteAndSignOut(): Promise<void> {
    setBusy(true);
    // Not signed out (ruling L5-11): no navigation. The drafts are already gone, so the warning closes (d2-sfh-2 finding 2)
    // and the rail's status line says the person is still signed in.
    if (!(await deleteDraftsAndSignOut(userId, onPhase))) {
      setBusy(false);
      setCount(null);
    }
  }

  return (
    <>
      <span onClickCapture={onClickCapture} style={{ display: 'contents' }}>{children}</span>
      {count !== null ? (
        // The guard sits in the sidebar's narrow footer; the warning is laid out over the page, beside the sidebar, so its
        // text and its three buttons have room (seen live: inside the footer they were clipped).
        <div
          role="alertdialog" aria-labelledby="sign-out-drafts-text" className="card" data-sign-out-drafts tabIndex={-1} ref={warning}
          style={{ position: 'fixed', insetInlineStart: '1rem', insetBlockEnd: '1rem', zIndex: 1000, width: 'min(32rem, calc(100vw - 2rem))', boxShadow: '0 4px 24px rgb(0 0 0 / 0.35)' }}
        >
          <p id="sign-out-drafts-text">{m41(count)}</p>
          <div className="form-actions">
            {/* A plain link: S-21 is another unit's page, and this is not a navigation to prefetch. */}
            <a className="ui-button ui-button--secondary" href="/account#drafts-on-this-device" onClick={() => setCount(null)}>{DRAFTS_COPY.signOut.goToThem}</a>
            {/* Busy, not disabled: the press keeps its focus while the drafts are purged and the sign-out runs (kit Button). */}
            <Button variant="primary" busy={busy} onClick={() => { void deleteAndSignOut(); }}>{DRAFTS_COPY.signOut.deleteAndSignOut}</Button>
            <Button variant="secondary" onClick={() => setCount(null)}>{DRAFTS_COPY.signOut.cancel}</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
