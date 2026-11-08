'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptIdleMessage,
  idlePhase,
  msToNextPhase,
  readSessionResponse,
  settleStay,
  signInAgainHref,
  stayOutcome,
  withMargin,
  type IdleDeadlines,
} from '@/lib/auth/idle';

const WARNING_TEXT = 'You will be signed out in 2 minutes because nothing has happened for a while.';
const FAILED_TEXT = 'Could not keep you signed in just now. Try again.';
const ENDED_TEXT = 'You have been signed out. What you typed is still on this page.';

/**
 * The signed-out notice (owner default B35). It is ordinary page content, not a dialog: nothing is
 * inert, so a mouse or touch user can still select and copy what they typed, and the link goes back
 * to the same address after signing in. `role="alert"` announces it when it appears.
 */
export function IdleEndedNotice({ signInHref }: { signInHref: string }) {
  return (
    <div role="alert" className="idle-ended">
      <p className="idle-ended__text">
        {ENDED_TEXT} <a href={signInHref}>Sign in again</a>
      </p>
    </div>
  );
}

/**
 * UX-43 (SRS 7.6.1; WCAG 2.2.1): two minutes before the session cookie expires, every signed-in
 * page asks whether the person is still there, and "Stay signed in" extends the session. The
 * 7-day absolute limit is not extended: this component only reads the session, and the read never
 * moves `sessionIssuedAt` (lib/auth/callbacks.ts). When the 7-day limit comes first there is no
 * warning at all (lib/auth/idle.ts, idlePhase).
 *
 * What it counts down. Not time since the page loaded: the session ends at the cookie's own `exp`,
 * which only sign-in and a read of GET /api/auth/session move, not page loads or saves (owner
 * default B33; ADR-0002 section 4). The layout reads the
 * cookie on the server (lib/auth/idleDeadline.ts) and passes the seconds left, so the browser's
 * clock does not matter; the component counts from the moment it received them. It counts 5 s
 * early for the delay between the server's render and this mount.
 *
 * A native `<dialog>` opened with `showModal()`: the browser gives it the inert page, focus
 * containment, the top layer and `Esc`, so it has no role, no aria-modal, no focus trap and no key
 * handler. Its native `cancel` event (Esc, the back gesture) counts as "Stay signed in"; the event
 * is not prevented, so the dialog closes as the platform does.
 *
 * Timers sleep with a laptop, so a single timeout is not enough. The check runs from one timeout to
 * the next phase boundary, every 15 s, and when the page becomes visible, is shown again from the
 * back-forward cache, regains focus or comes back online. None of these is a request; the only
 * request is the one "Stay signed in" sends (NFR-PERF-05: at most one poll a minute, and this is
 * none).
 *
 * When the deadline arrives the dialog closes and nothing else happens: no request, no navigation,
 * no storage access, no purge. The server has ended the session; the next Save shows M-08 and the
 * next navigation reaches /login, and an open modal would make DEC-b's Save inert (RF-3).
 * SignOutWithDraftsGuard stays the only purge path.
 */
export default function IdleWarning({
  idleSeconds,
  secondsLeft,
  absoluteSecondsLeft,
}: {
  idleSeconds: number;
  secondsLeft: number;
  absoluteSecondsLeft: number;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The deadlines the countdown runs against (already less the margin) and the moment it started.
  const deadlinesRef = useRef<IdleDeadlines>({ secondsLeft: 0, absoluteSecondsLeft: 0 });
  const baseRef = useRef(0);
  const readingRef = useRef(false);
  const signedOutRef = useRef(false);
  // Counts the restarts of the countdown, so a read that was overtaken by one can be told from one that was not.
  const generationRef = useRef(0);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInHref, setSignInHref] = useState<string | null>(null);

  const elapsedSeconds = () => (Date.now() - baseRef.current) / 1000;

  // Decides what the clock says now and sets the next wake-up. Safe to call as often as is wanted.
  // (A named function expression: it schedules itself, and a const cannot be read inside its own initialiser.)
  const check = useCallback(function checkNow() {
    clearTimeout(timerRef.current);
    const dialog = dialogRef.current;
    const progress = { ...deadlinesRef.current, elapsedSeconds: elapsedSeconds() };
    const phase = idlePhase(progress);
    if (phase === 'warning') {
      if (dialog && !dialog.open && !signedOutRef.current && !readingRef.current) {
        dialog.showModal();
        stayRef.current?.focus();
      }
    } else if (phase === 'ended') {
      if (dialog?.open) dialog.close();
    }
    const wait = msToNextPhase(progress);
    if (wait !== null) timerRef.current = setTimeout(checkNow, wait);
  }, []);

  // Starts a new countdown from these deadlines: after an extension, an accepted message from another tab. An extension means
  // the session is alive, so a signed-out notice from before it is stale and the warning may open again.
  const restart = useCallback(
    (next: IdleDeadlines) => {
      deadlinesRef.current = withMargin(next);
      baseRef.current = Date.now();
      generationRef.current += 1;
      signedOutRef.current = false;
      setSignInHref(null);
      setFailed(false);
      if (dialogRef.current?.open) dialogRef.current.close();
      check();
    },
    [check],
  );

  // The server's numbers: at mount, and again whenever a full load or router.refresh() renders the layout anew.
  useEffect(() => {
    deadlinesRef.current = withMargin({ secondsLeft, absoluteSecondsLeft });
    baseRef.current = Date.now();
    check();
    return () => clearTimeout(timerRef.current);
  }, [secondsLeft, absoluteSecondsLeft, check]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    const tick = setInterval(check, 15_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [check]);

  // Other tabs of the same browser: one tab's extension is every tab's.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('makrai-idle');
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const accepted = acceptIdleMessage(event.data, idleSeconds);
      if (accepted) restart(accepted);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [idleSeconds, restart]);

  // A disabled button gives up focus; give it back once the read is over and the dialog is still there.
  useEffect(() => {
    if (!busy && failed && dialogRef.current?.open) stayRef.current?.focus();
  }, [busy, failed]);

  async function stay() {
    if (readingRef.current) return;
    readingRef.current = true;
    const generation = generationRef.current;
    setBusy(true);
    setFailed(false);
    let read: Awaited<ReturnType<typeof readSessionResponse>>;
    try {
      // One plain GET of the session. Reading it makes the server sign the cookie again with a
      // fresh expiry; it writes nothing and cannot move the 7-day limit. 30 s is SRS 7.4.1's give-up threshold.
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      read = await readSessionResponse(response);
    } catch {
      // A refused connection, the 30 s timeout: no answer, which is a failed read and is shown as one below.
      read = { status: 'network', body: null };
    }
    readingRef.current = false;
    setBusy(false);
    // Another tab's extension restarted the countdown while this read was in flight: its answer belongs to a deadline that has
    // since moved, so a failure must not open a modal that says two minutes are left when the session has hours.
    if (generation !== generationRef.current) return;

    const elapsed = elapsedSeconds();
    const absoluteNow = deadlinesRef.current.absoluteSecondsLeft - elapsed;
    const phaseNow = idlePhase({ ...deadlinesRef.current, elapsedSeconds: elapsed });
    const outcome = settleStay(stayOutcome(read.status, read.body, absoluteNow), phaseNow);
    const dialog = dialogRef.current;

    if (outcome === 'extended') {
      const next = { secondsLeft: idleSeconds, absoluteSecondsLeft: Math.max(0, Math.floor(absoluteNow)) };
      restart(next);
      channelRef.current?.postMessage(next);
    } else if (outcome === 'failed') {
      setFailed(true);
      // Esc closed the dialog before the read came back: open it again so the line is seen.
      if (dialog && !dialog.open) {
        dialog.showModal();
        stayRef.current?.focus();
      }
    } else {
      // Ended: the modal gives way to a notice in the page, so what the person typed can still be read and copied.
      signedOutRef.current = true;
      if (dialog?.open) dialog.close();
      setSignInHref(signInAgainHref(window.location.pathname, window.location.search));
    }
  }

  return (
    <>
      {signInHref ? <IdleEndedNotice signInHref={signInHref} /> : null}
      <dialog
        ref={dialogRef}
        className="idle-warning"
        aria-labelledby="idle-warning-text"
        data-seconds-left={secondsLeft}
        onCancel={() => void stay()}
      >
        <p id="idle-warning-text">{WARNING_TEXT}</p>
        <button ref={stayRef} type="button" className="btn btn--primary" autoFocus disabled={busy} onClick={() => void stay()}>
          Stay signed in
        </button>
        {failed ? <p role="alert">{FAILED_TEXT}</p> : null}
      </dialog>
    </>
  );
}
