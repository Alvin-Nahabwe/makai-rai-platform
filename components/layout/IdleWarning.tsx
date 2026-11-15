'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptIdleMessage,
  clearSignedOutHint,
  endReason,
  idlePhase,
  msToNextPhase,
  readSessionResponse,
  settleStay,
  signInAgainHref,
  stayOutcome,
  tabStorage,
  withMargin,
  writeSignedOutHint,
  type IdleDeadlines,
} from '@/lib/auth/idle';
import { IDLE_TEXTS } from '@/lib/auth/session/copy';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

/** Why the session ended, as the clock tells it; null when the server ended it before either deadline. */
export type EndedReason = 'idle' | 'absolute' | null;

/**
 * The signed-out notice (owner default B35; plan 1B Task 4, C12). It is ordinary page content, not a dialog: nothing is
 * inert, so a mouse or touch user can still select and copy what they typed, and the link goes back to the same address
 * after signing in. It says why the session ended, the 12-hour or the 7-day rule, or no reason when the clock cannot tell.
 * `role="alert"` announces it when it appears: the kit's Banner is not a live region, so the alert is this wrapper's.
 */
export function IdleEndedNotice({ signInHref, reason }: { signInHref: string; reason: EndedReason }) {
  const why = reason === 'idle' ? IDLE_TEXTS.endedIdle : reason === 'absolute' ? IDLE_TEXTS.endedAbsolute : IDLE_TEXTS.endedElsewhere;
  return (
    <div role="alert" className="shell-idle__ended">
      <Banner kind="session">
        <p>{why} {IDLE_TEXTS.endedKept}</p>
        {/* The one way forward, a link drawn as the kit's primary button (44 px; design review I-7), under the text at every
            width. A plain link: it is a full load, which reads the session afresh. */}
        <a className="ui-button ui-button--primary" href={signInHref} style={{ marginBlockStart: 'var(--space-3)' }}>{IDLE_TEXTS.signInAgain}</a>
      </Banner>
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
 * The kit's Dialog, a native `<dialog>` opened with `showModal()`: the browser gives it the inert page,
 * focus containment, the top layer and `Esc`, so it has no role, no aria-modal, no focus trap and no key
 * handler. The browser closing it (Esc, the back gesture: the native `cancel`, which Dialog reports as
 * `onClose`) counts as "Stay signed in"; the event is not prevented, so the dialog closes as the platform
 * does. showModal() focuses the first focusable element, which is Stay signed in. The seconds the server
 * handed over are on the wrapper, `data-seconds-left`, read by the specs and the release's live run.
 *
 * Timers sleep with a laptop, so a single timeout is not enough. The check runs from one timeout to
 * the next phase boundary, every 15 s, and when the page becomes visible, is shown again from the
 * back-forward cache, regains focus or comes back online. None of these is a request; the only
 * request is the one "Stay signed in" sends (NFR-PERF-05: at most one poll a minute, and this is
 * none).
 *
 * When the deadline arrives the dialog closes and the signed-out notice takes its place, once per ending, with the
 * reason endReason gives (plan 1B Task 4, C12). No request, no navigation, no purge. The one storage access is the
 * signed-out hint in this tab's sessionStorage (lib/auth/idle.ts SIGNED_OUT_HINT_KEY, never a draft key): written at an
 * ending the clock explains, so S-01 can say why, and removed at mount and on an extension, when the session is known to
 * be alive. The server has ended the session; the next Save shows M-08 and the next navigation reaches /login, and an
 * open modal would make DEC-b's Save inert (RF-3). SignOutWithDraftsGuard stays the only purge path.
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
  // Whether the warning is open: state for the Dialog, and a ref that mirrors it for check, restart and stay, which run
  // from timers and listeners and are not re-created.
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
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
  const [ended, setEnded] = useState<{ href: string; reason: EndedReason } | null>(null);

  const elapsedSeconds = () => (Date.now() - baseRef.current) / 1000;
  const setWarningOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  // The session has ended: once per ending, the modal gives way to the notice in the page, so what the person typed can
  // still be read and copied, and S-01 is left the reason when the clock gives one.
  const showEnded = useCallback((reason: EndedReason) => {
    if (signedOutRef.current) return;
    signedOutRef.current = true;
    if (openRef.current) setWarningOpen(false);
    setEnded({ href: signInAgainHref(window.location.pathname, window.location.search), reason });
    if (reason !== null) writeSignedOutHint(tabStorage(), reason, Date.now());
  }, [setWarningOpen]);

  // Decides what the clock says now and sets the next wake-up. Safe to call as often as is wanted.
  // (A named function expression: it schedules itself, and a const cannot be read inside its own initialiser.)
  const check = useCallback(function checkNow() {
    clearTimeout(timerRef.current);
    const progress = { ...deadlinesRef.current, elapsedSeconds: elapsedSeconds() };
    const phase = idlePhase(progress);
    if (phase === 'warning') {
      if (!openRef.current && !signedOutRef.current && !readingRef.current) setWarningOpen(true);
    } else if (phase === 'ended') {
      showEnded(endReason(progress));
    }
    const wait = msToNextPhase(progress);
    if (wait !== null) timerRef.current = setTimeout(checkNow, wait);
  }, [setWarningOpen, showEnded]);

  // Starts a new countdown from these deadlines: after an extension, an accepted message from another tab. An extension means
  // the session is alive, so a signed-out notice from before it is stale and the warning may open again.
  const restart = useCallback(
    (next: IdleDeadlines) => {
      deadlinesRef.current = withMargin(next);
      baseRef.current = Date.now();
      generationRef.current += 1;
      signedOutRef.current = false;
      setEnded(null);
      clearSignedOutHint(tabStorage());
      setFailed(false);
      if (openRef.current) setWarningOpen(false);
      check();
    },
    [check, setWarningOpen],
  );

  // The server's numbers: at mount, and again whenever a full load or router.refresh() renders the layout anew.
  useEffect(() => {
    deadlinesRef.current = withMargin({ secondsLeft, absoluteSecondsLeft });
    baseRef.current = Date.now();
    // The server has just read a live session: a hint from an earlier ending in this tab is stale.
    clearSignedOutHint(tabStorage());
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

    if (outcome === 'extended') {
      const next = { secondsLeft: idleSeconds, absoluteSecondsLeft: Math.max(0, Math.floor(absoluteNow)) };
      restart(next);
      channelRef.current?.postMessage(next);
    } else if (outcome === 'failed') {
      setFailed(true);
      // Esc closed the dialog before the read came back: open it again so the line is seen.
      if (!openRef.current) setWarningOpen(true);
    } else {
      // Ended. Before either deadline the server ended it (sign out everywhere, a password change): no reason is given.
      showEnded(endReason({ ...deadlinesRef.current, elapsedSeconds: elapsed }));
    }
  }

  // The browser closed the dialog (Esc, the back gesture): that counts as Stay signed in.
  function onBrowserClose() {
    setWarningOpen(false);
    void stay();
  }

  return (
    <div className="shell-idle" data-seconds-left={secondsLeft}>
      {ended ? <IdleEndedNotice signInHref={ended.href} reason={ended.reason} /> : null}
      <Dialog
        open={open}
        title={IDLE_TEXTS.warningTitle}
        onClose={onBrowserClose}
        actions={
          <Button variant="primary" busy={busy} onClick={() => void stay()}>
            {IDLE_TEXTS.stay}
          </Button>
        }
      >
        {/* One paragraph, so no stylesheet of its own: this component is in every page's first visit, S-04's too. */}
        <p>{IDLE_TEXTS.warningBody} {IDLE_TEXTS.warningKept}</p>
        {failed ? <p role="alert" className="shell-idle__failed">{IDLE_TEXTS.stayFailed}</p> : null}
      </Dialog>
    </div>
  );
}
