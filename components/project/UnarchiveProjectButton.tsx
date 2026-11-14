'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { signInAgainHref } from '@/lib/auth/idle';
import { refusalOf } from '@/lib/projects/writeRefusal';
import { PROJECT_WRITE_COPY } from '@/lib/project/write/copy';

const FRESH: RetryState = { requestId: null, sentBody: null };
const C = PROJECT_WRITE_COPY.unarchive;

/**
 * Unarchive on S-32 (FR-PRJ-03, UX-27): POST route 22 with a request id that a Retry repeats. One `role="status"` region
 * is in the page from the first render and is filled, so a screen reader announces the slow, lost and refused lines. A 204,
 * or 409 (another person unarchived it first), refreshes the page; a 401 goes to sign in; a 403 or 404 keeps its line and
 * disables the button without a refresh (the refresh would remove the row's control and the line); a server error offers Retry.
 *
 * Focus (SC 2.4.3; ruling L5-4): the pressed button stays, focusable and `aria-busy`, while its own request is in flight
 * (never `disabled` during its send), and Retry stays, busy, while its own request is in flight. When the answer
 * arrives focus goes to Retry after a lost connection or a server error, and to this control's container after a refusal
 * that disables the button. The button is native, in the kit's classes: it needs `aria-label`, which the kit's Button
 * cannot carry.
 */
export function UnarchiveProjectButton(p: { orgSlug: string; projectId: string; projectName?: string }): ReactElement {
  const router = useRouter();
  const retry = useRef<RetryState>(FRESH);
  const box = useRef<HTMLSpanElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  /** Where focus goes after the next render: set when an answer arrives, used once by the effect below. */
  const focusNext = useRef<'retry' | 'box' | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [stopped, setStopped] = useState(false);

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
    setLine('');
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    const outcome = await sendWrite(`/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/unarchive`, 'POST', { requestId }, { onSlow: () => setLine(C.slow) });
    inFlight.current = false;
    setBusy(false);
    if (outcome.kind === 'not_saved') {
      setLine(C.lost);   // keep the id: a Retry is answered again if the first request had arrived
      setCanRetry(true);
      focusNext.current = 'retry';
      return;
    }
    if (outcome.kind === 'saved') {
      retry.current = FRESH;
      setLine('');
      setCanRetry(false);
      router.refresh();
      return;
    }
    const r = refusalOf(outcome.status);
    if (r.kind === 'signin') {
      window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
    } else if (r.kind === 'stop') {
      retry.current = FRESH;   // the same request would be refused again
      setLine(r.line);
      setStopped(true);
      setCanRetry(false);
      focusNext.current = 'box';
    } else if (r.kind === 'refresh') {
      retry.current = FRESH;
      setLine('');
      setCanRetry(false);
      router.refresh();
    } else {
      setLine(C.failed);   // keep the id
      setCanRetry(true);
      focusNext.current = 'retry';
    }
  }

  return (
    <span ref={box} tabIndex={-1}>
      {canRetry ? (
        <Button ref={retryButton} variant="secondary" size="compact" busy={busy} onClick={() => { void send(); }}>{C.retry}</Button>
      ) : (
        <button
          type="button" className="ui-button ui-button--secondary ui-button--compact" disabled={stopped} aria-busy={busy ? true : undefined}
          aria-label={p.projectName === undefined ? undefined : C.named(p.projectName)} onClick={() => { void send(); }}
        >
          {C.button}
        </button>
      )}{' '}
      <span role="status">{line}</span>
    </span>
  );
}
