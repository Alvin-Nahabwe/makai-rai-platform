'use client';

import { useEffect, useRef, useState } from 'react';
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
 * this control's container, which holds the status line.
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

  // UX-42, X-4: the confirmation has no field, so focus goes to its Cancel button, the first of its actions.
  useEffect(() => {
    if (confirming) box.current?.querySelector<HTMLButtonElement>('.ui-confirm__actions button')?.focus();
  }, [confirming]);

  // After the render that follows an answer, focus goes to what that render left in place.
  useEffect(() => {
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
      setStatus(C.lost);
      setCanRetry(true);
      focusNext.current = 'retry';
      return;
    }
    if (outcome.kind === 'saved' || (outcome.kind === 'rejected' && outcome.status === 409 && outcome.body.code === 'already_archived')) {
      retry.current = FRESH;
      setStatus(C.archived);
      setCanRetry(false);
      focusNext.current = 'box';
      router.refresh();
      return;
    }
    const r = refusalOf(outcome.status);
    if (r.kind === 'signin') {
      window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
    } else if (r.kind === 'stop') {
      retry.current = FRESH;   // the same request would be refused again
      setStatus(r.line);       // no refresh: the refreshed page leaves this control out and the line with it
      setStopped(true);
      setCanRetry(false);
      focusNext.current = 'box';
    } else if (r.kind === 'refresh') {
      retry.current = FRESH;
      setStatus(null);   // another state: the refreshed page shows what applies now
      setCanRetry(false);
      focusNext.current = 'box';
      router.refresh();
    } else {
      // A server error or a limit: say so, keep the id, and let the person try again.
      setStatus(C.failed);
      setCanRetry(true);
      focusNext.current = 'retry';
    }
  }

  function cancel(): void {
    setConfirming(false);
    // the trigger is back unless a request is in flight; then the container, which holds the status line, takes focus
    (busy ? box : trigger).current?.focus();
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
