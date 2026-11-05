'use client';

import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { signInAgainHref } from '@/lib/auth/idle';
import { refusalOf } from '@/lib/projects/writeRefusal';

const FRESH: RetryState = { requestId: null, sentBody: null };
const SLOW_LINE = 'Still saving. The connection is slow.';

/**
 * Unarchive on S-32 (FR-PRJ-03, UX-27): POST route 22 with a request id that a Retry repeats. One `role="status"` region
 * is in the page from the first render and is filled, so a screen reader announces the slow, lost and refused lines. A 204,
 * or 409 (another person unarchived it first), refreshes the page; a 401 goes to sign in; a 403 or 404 keeps its line and
 * disables the button without a refresh (the refresh would remove the row's control and the line); a server error offers Retry.
 */
export function UnarchiveProjectButton(p: { orgSlug: string; projectId: string; projectName?: string }): ReactElement {
  const router = useRouter();
  const retry = useRef<RetryState>(FRESH);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [stopped, setStopped] = useState(false);

  async function send(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setCanRetry(false);
    setLine('');
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    const outcome = await sendWrite(`/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/unarchive`, 'POST', { requestId }, { onSlow: () => setLine(SLOW_LINE) });
    setBusy(false);
    if (outcome.kind === 'not_saved') {
      setLine('Not unarchived: connection lost.');   // keep the id: a Retry is answered again if the first request had arrived
      setCanRetry(true);
      return;
    }
    if (outcome.kind === 'saved') {
      retry.current = FRESH;
      setLine('');
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
    } else if (r.kind === 'refresh') {
      retry.current = FRESH;
      setLine('');
      router.refresh();
    } else {
      setLine('Not unarchived: something went wrong. Please try again.');   // keep the id
      setCanRetry(true);
    }
  }

  return (
    <span>
      {canRetry ? (
        <button type="button" className="btn btn--secondary btn--small" onClick={() => { void send(); }}>Retry</button>
      ) : (
        <button type="button" className="btn btn--secondary btn--small" disabled={busy || stopped} aria-label={p.projectName === undefined ? undefined : `Unarchive ${p.projectName}`} onClick={() => { void send(); }}>Unarchive</button>
      )}{' '}
      <span role="status">{line}</span>
    </span>
  );
}
