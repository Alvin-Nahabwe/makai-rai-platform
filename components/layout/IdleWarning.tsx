'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE_WARNING_SECONDS } from '@/lib/auth/idle';

/** Milliseconds from now until the warning opens: `IDLE_WARNING_SECONDS` before the idle limit. */
export function warningDelayMs(idleSeconds: number): number {
  return Math.max(0, idleSeconds - IDLE_WARNING_SECONDS) * 1000;
}

const WARNING_TEXT = 'You will be signed out in 2 minutes because nothing has happened for a while.';
const FAILED_TEXT = 'Could not reach the server. Your answer is kept on this device. Try again.';

/**
 * UX-43 (SRS 7.6.1; WCAG 2.2.1): two minutes before the idle sign-out, every
 * signed-in page asks whether the person is still there, and "Stay signed in"
 * extends the session. The 7-day absolute limit is not extended: this component
 * only reads the session, and the read never moves `sessionIssuedAt`
 * (lib/auth/callbacks.ts).
 *
 * A native `<dialog>` opened with `showModal()`: the browser gives it the inert
 * page, focus containment, the top layer, `Esc`, and the return of focus, so it
 * has no role, no aria-modal, no focus trap and no key handler of its own.
 *
 * When the timer starts. It starts when the layout mounts, and again after "Stay
 * signed in". It does NOT start again on a change of address or on other requests,
 * although the unit brief asked for that: measured on the slot's dev server, the
 * session cookie's expiry stayed put across authenticated page loads and moved only
 * on GET /api/auth/session (the session read this component makes), because the
 * server components read the session with `auth()` and next-auth drops the
 * refreshed cookie on that path (node_modules/next-auth/lib/index.js:58-63).
 * Restarting on navigation would push the warning past the real expiry. The deadline
 * the server actually holds is open question N1 in the unit report.
 *
 * Nothing here sends a request until the button is pressed (NFR-PERF-05: at most one
 * poll a minute, and this is none).
 */
export default function IdleWarning({ idleSeconds }: { idleSeconds: number }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const openWarning = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    stayRef.current?.focus();
  }, []);

  const restartTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(openWarning, warningDelayMs(idleSeconds));
  }, [idleSeconds, openWarning]);

  // Starts at mount; stayHandler starts it again after a successful session read.
  useEffect(() => {
    restartTimer();
    return () => clearTimeout(timerRef.current);
  }, [restartTimer]);

  async function stayHandler() {
    setBusy(true);
    setFailed(false);
    try {
      // One plain GET of the session. Reading it makes the server sign the cookie again with a
      // fresh expiry; it writes nothing and cannot move the 7-day limit.
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const session = response.ok ? await response.json() : null;
      if (!session || typeof session !== 'object') {
        setFailed(true);
        return;
      }
      dialogRef.current?.close();
      restartTimer();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="idle-warning" aria-labelledby="idle-warning-text">
      <p id="idle-warning-text">{WARNING_TEXT}</p>
      {failed ? <p role="alert">{FAILED_TEXT}</p> : null}
      <button ref={stayRef} type="button" className="btn btn--primary" autoFocus disabled={busy} onClick={stayHandler}>
        Stay signed in
      </button>
    </dialog>
  );
}
