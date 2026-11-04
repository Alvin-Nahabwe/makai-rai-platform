'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { signOut } from 'next-auth/react';
import { openDraftStore } from '@/lib/client/drafts';

export type SignOutWithDraftsGuardProps = { userId: string; children: ReactNode };

/** M-41 (SRS 7.5.7), without its two bracketed actions, which are the buttons below it. */
export const m41 = (n: number): string =>
  `You have ${n} answers on this device that are not saved. If you sign out, they are deleted from this device.`;

/**
 * The guard around the sidebar's Sign out button (M-41, UX-26, NFR-PRIV-06, FR-DEC-06). A press is caught before the
 * button's own handler runs: when this device holds drafts of this account, M-41 shows instead, with **Go to them**
 * (S-21's drafts list) and **Delete them and sign out**, which deletes this account's drafts and then signs out. With
 * no draft, or no storage, the press goes through to the button unchanged.
 *
 * This is the only place drafts are deleted at sign-out. An idle sign-out runs no client code, so it keeps them
 * (R-53, SRS line 5907), and the next account's sign-in removes them (ACC-b's `purgeOtherAccounts`).
 */
export function SignOutWithDraftsGuard({ userId, children }: SignOutWithDraftsGuardProps): ReactElement {
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
    openDraftStore()?.purgeAccount(userId);
    await signOut({ callbackUrl: '/login' });
  }

  return (
    <>
      <span onClickCapture={onClickCapture} style={{ display: 'contents' }}>{children}</span>
      {count !== null ? (
        <div role="alertdialog" aria-labelledby="sign-out-drafts-text" className="card" data-sign-out-drafts tabIndex={-1} ref={warning}>
          <p id="sign-out-drafts-text">{m41(count)}</p>
          <div className="form-actions">
            {/* A plain link: S-21 is another unit's page, and this is not a navigation to prefetch. */}
            <a className="btn btn--secondary" href="/account#drafts-on-this-device" onClick={() => setCount(null)}>Go to them</a>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { void deleteAndSignOut(); }}>Delete them and sign out</button>
            <button type="button" className="btn btn--secondary" onClick={() => setCount(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
