'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { signInAgainHref } from '@/lib/auth/idle';
import { refusalOf } from '@/lib/projects/writeRefusal';
import { PROJECT_WRITE_COPY } from '@/lib/project/write/copy';

const FRESH: RetryState = { requestId: null, sentBody: null };
const C = PROJECT_WRITE_COPY.archive;

/**
 * The Archive control of S-10 (FR-PRJ-03, UX-29, UX-27; SRS 7.4.2 row S-10). The button opens an inline confirmation
 * that names the project and what archiving does; confirming sends route 21 with a request id that a Retry repeats
 * (a request that had arrived is answered again, not refused). One `role="status"` line says what became of it, and
 * it stays across the `router.refresh()` that follows: this component keeps its place in the tree, so it also stays
 * mounted once the project is archived, with its button gone.
 *
 * Focus (SC 2.4.3; register D-398 item 2, ruling L5-4): it is never dropped to the page body, and a pressed control is
 * never removed or disabled while its own request is in flight. The confirmation opens on its Cancel button (it has no
 * field) and stays open, its confirm button busy, until the answer arrives; Retry stays, busy, while its own request is
 * in flight. When the answer arrives focus goes to Retry after a lost connection or a server error, and otherwise to
 * this control's container, which holds the status line. Cancel does nothing while the request is in flight (ruling
 * L5-15): the archive cannot be stopped once sent, so the confirmation stays open, busy, until the answer arrives.
 */
export function ArchiveProjectControl(p: { orgSlug: string; projectId: string; projectName: string; archived: boolean }): ReactElement | null {
  const router = useRouter();
  const retry = useRef<RetryState>(FRESH);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  /** Where focus goes after the next render: set when an answer arrives, used once by the effect below. */
  const focusNext = useRef<'retry' | 'box' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [stopped, setStopped] = useState(false);   // the role was lowered or the project is gone: the control stays, disabled, with its line

  // UX-42, X-4: the confirmation has no field, so focus goes to its Cancel button, the first of its actions. This reaches
  // into the kit's markup by class and order; the order (Cancel first, inside __actions) is pinned by the kit's unit case
  // "Cancel comes before the confirm button in the markup, inside __actions" (__tests__/unit/ui/inline-confirm.test.tsx).
  useEffect(() => {
    if (confirming) box.current?.querySelector<HTMLButtonElement>('.ui-confirm__actions button')?.focus();
  }, [confirming]);

  // After the render that follows an answer, focus goes to what that render left in place. A layout effect: focus moves in
  // the same commit that removed the focused confirm button or Retry, so no painted frame has it on the page body.
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    (target === 'retry' ? retryButton.current : box.current)?.focus();
  });

  async function send(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(C.archiving);
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    const outcome = await sendWrite(`/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/archive`, 'POST', { requestId }, { onSlow: () => setStatus(C.slow) });
    inFlight.current = false;
    setBusy(false);
    setConfirming(false);
    if (outcome.kind === 'not_saved') {
      // Keep the id: a Retry sends the same request, which the server answers again if it had arrived.
      focusNext.current = 'retry';
      setStatus(C.lost);
      setCanRetry(true);
      return;
    }
    if (outcome.kind === 'saved' || (outcome.kind === 'rejected' && outcome.status === 409 && outcome.body.code === 'already_archived')) {
      retry.current = FRESH;
      focusNext.current = 'box';
      setStatus(C.archived);
      setCanRetry(false);
      router.refresh();
      return;
    }
    const r = refusalOf(outcome.status);
    if (r.kind === 'signin') {
      window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
    } else if (r.kind === 'stop') {
      retry.current = FRESH;   // the same request would be refused again
      focusNext.current = 'box';
      setStatus(r.line);       // no refresh: the refreshed page leaves this control out and the line with it
      setStopped(true);
      setCanRetry(false);
    } else if (r.kind === 'refresh') {
      retry.current = FRESH;
      focusNext.current = 'box';
      setStatus(null);   // another state: the refreshed page shows what applies now
      setCanRetry(false);
      router.refresh();
    } else {
      // A server error or a limit: say so, keep the id, and let the person try again.
      focusNext.current = 'retry';
      setStatus(C.failed);
      setCanRetry(true);
    }
  }

  function cancel(): void {
    // ruling L5-15: a request in flight cannot be called back, so Cancel then does nothing and the confirmation stays
    // open and busy: closing it would say the archive was cancelled while the project is archived a moment later
    if (inFlight.current) return;
    setConfirming(false);
    trigger.current?.focus();   // the trigger is back
  }

  if (p.archived && status === null) return null;
  return (
    <div className="archive-control" ref={box} tabIndex={-1}>
      {!p.archived && !busy && !canRetry ? (
        <Button ref={trigger} variant="secondary" disabled={stopped} onClick={() => setConfirming(true)}>{C.trigger}</Button>
      ) : null}
      {!p.archived && confirming ? (
        <InlineConfirm
          objectName={C.objectName(p.projectName)}
          consequence={C.consequence}
          actionLabel={C.action}
          onConfirm={send}
          onCancel={cancel}
          busy={busy}
          destructive
        />
      ) : null}
      <p role="status">{status}</p>
      {canRetry ? <Button ref={retryButton} variant="secondary" busy={busy} onClick={() => { void send(); }}>{C.retry}</Button> : null}
    </div>
  );
}
