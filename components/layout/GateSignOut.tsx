'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { countAccountDrafts } from '@/lib/client/draftKeys';
import { useSignOutPress } from '@/lib/client/signOutPress';
import { DRAFTS_COPY } from '@/lib/decision/drafts/copy';
import { GATE_COPY } from '@/lib/shell/copy';

export type DraftsWarningProps = { count: number; accountReachable: boolean; busy: boolean; onDelete: () => void; onCancel: () => void };

/**
 * M-41 (SRS 7.5.7) in the gate frame, in SignOutWithDraftsGuard's words and structure (components/decision/
 * SignOutWithDraftsGuard.tsx): the warning, then **Go to them** (S-21's drafts list), **Delete them and sign out** and
 * **Cancel** (Escape too). Go to them is offered only when My account is reachable: gate 2 holds a flagged account on S-29
 * and would send it straight back. Laid over the page, as the guard lays it, so its text and buttons have room; it takes
 * focus when it opens, and Cancel gives it back to Sign out.
 */
export function DraftsWarning({ count, accountReachable, busy, onDelete, onCancel }: DraftsWarningProps): ReactElement {
  const warning = useRef<HTMLDivElement | null>(null);
  useEffect(() => { warning.current?.focus(); }, []);
  return (
    <div
      role="alertdialog" aria-labelledby="sign-out-drafts-text" className="card" data-sign-out-drafts tabIndex={-1} ref={warning}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
      style={{ position: 'fixed', insetInlineStart: '1rem', insetBlockEnd: '1rem', zIndex: 1000, width: 'min(32rem, calc(100vw - 2rem))', boxShadow: '0 4px 24px rgb(0 0 0 / 0.35)' }}
    >
      <p id="sign-out-drafts-text">{DRAFTS_COPY.signOut.warning(count)}</p>
      <div className="form-actions">
        {accountReachable ? (
          // A plain link, as the guard's: S-21 is another unit's page, and this is not a navigation to prefetch.
          <a className="ui-button ui-button--secondary" href="/account#drafts-on-this-device" onClick={onCancel}>{DRAFTS_COPY.signOut.goToThem}</a>
        ) : null}
        {/* Busy, not disabled: the press keeps its focus while the drafts are removed and the sign-out runs (kit Button). */}
        <Button variant="primary" busy={busy} onClick={onDelete}>{DRAFTS_COPY.signOut.deleteAndSignOut}</Button>
        <Button variant="secondary" onClick={onCancel}>{DRAFTS_COPY.signOut.cancel}</Button>
      </div>
    </div>
  );
}

/**
 * The frame's Sign out (plan 1B Task 1). A form, so a press before hydration still signs out: it goes to next-auth's own
 * sign-out page (`GET /api/auth/signout`), which asks once more and posts with next-auth's CSRF token; no token is handled
 * here, and no script of this app runs there, so that path removes no draft (an idle sign-out does not either; the next
 * account's sign-in on this browser does, `purgeOtherAccounts`).
 *
 * Once hydrated, a press is caught. When this device holds drafts of this account, M-41 shows first, as the rail's Sign out
 * shows it (lead's ruling L5-20), and only **Delete them and sign out** goes on; with none, the sign-out runs at once. The
 * sign-out itself is S-05's press (lib/client/signOutPress.ts: signOutClearingDrafts to S-01, and on a failure the alert
 * region under the button says the person is still signed in, and nothing navigates). The drafts are counted by their keys
 * alone (lib/client/draftKeys.ts), so the draft store is not in this page's first visit. The button wears the rail's Sign out
 * class (app/globals.css) and says aria-busy while a press is carried out.
 */
export function GateSignOut({ userId, accountReachable }: { userId: string; accountReachable: boolean }): ReactElement {
  const signOut = useSignOutPress(userId, '/login');
  const [drafts, setDrafts] = useState<number | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  function closeWarning(): void {
    setDrafts(null);
    button.current?.focus();
  }
  // A press that failed from inside the warning: signOutClearingDrafts removes the drafts before it signs out, so the
  // warning's count may be stale. It closes when the failure line appears, and focus goes back to Sign out, under which
  // the failure line now speaks. Only when the line changes (React's "storing information from previous renders"; a
  // setState in an effect is refused by the lint rule react-hooks/set-state-in-effect): closing on every render while an
  // old failure is shown would close the next press's warning before it opens (review R1-1).
  const [lineSeen, setLineSeen] = useState<string | null>(signOut.message);
  if (signOut.message !== lineSeen) {
    setLineSeen(signOut.message);
    if (signOut.message !== null) setDrafts(null);
  }
  useEffect(() => {
    if (signOut.message !== null) button.current?.focus();
  }, [signOut.message]);
  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const n = countAccountDrafts(userId);
    if (n > 0) setDrafts(n);
    else signOut.press();
  }
  return (
    <form className="gate__signout" method="get" action="/api/auth/signout" onSubmit={onSubmit}>
      <input type="hidden" name="callbackUrl" value="/login" />
      <button type="submit" className="shell-rail__signout" aria-busy={signOut.busy ? true : undefined} ref={button}>
        <Icon name="log-out" />
        {GATE_COPY.signOut}
      </button>
      <StatusRegion politeness="assertive" tone="error" message={signOut.message} />
      {drafts !== null ? (
        <DraftsWarning count={drafts} accountReachable={accountReachable} busy={signOut.busy}
          onDelete={signOut.press} onCancel={closeWarning} />
      ) : null}
    </form>
  );
}
