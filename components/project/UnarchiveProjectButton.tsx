'use client';

import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { signInAgainHref } from '@/lib/auth/idle';

const FRESH: RetryState = { requestId: null, sentBody: null };

/**
 * Unarchive on S-32 (FR-PRJ-03, UX-27): POST route 22 with a request id that a Retry repeats. A 204, or 409
 * `not_archived` (another person unarchived it first), refreshes the page; a lost connection says so and offers Retry;
 * any other refusal (a role lowered, a project gone) refreshes so the page shows what applies now.
 */
export function UnarchiveProjectButton(p: { orgSlug: string; projectId: string; projectName?: string }): ReactElement {
  const router = useRouter();
  const retry = useRef<RetryState>(FRESH);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);
  const [failed, setFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLost(false);
    setFailed(false);
    setSlow(false);
    setMessage(null);
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    const outcome = await sendWrite(`/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/unarchive`, 'POST', { requestId }, { onSlow: () => setSlow(true) });
    setBusy(false);
    setSlow(false);
    if (outcome.kind === 'not_saved') {
      setLost(true);   // keep the id: a Retry is answered again if the first request had arrived
      return;
    }
    if (outcome.kind === 'rejected' && outcome.status === 401) {
      window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
      return;
    }
    if (outcome.kind === 'rejected' && (outcome.status === 403 || outcome.status === 404)) {
      retry.current = FRESH;   // the same request would be refused again
      setMessage(outcome.status === 403 ? 'You can no longer change this project.' : 'This project no longer exists.');
      router.refresh();
      return;
    }
    if (outcome.kind === 'rejected' && outcome.status !== 409) {
      setFailed(true);   // a server error or a limit: say so, keep the id
      return;
    }
    retry.current = FRESH;
    router.refresh();
  }

  return (
    <span>
      {slow ? <span role="status">Still saving. The connection is slow.</span> : null}
      {message !== null ? <span role="status">{message}</span> : null}
      {lost || failed ? (
        <>
          <span role="status">{lost ? 'Not unarchived: connection lost.' : 'Not unarchived: something went wrong. Please try again.'}</span>{' '}
          <button type="button" className="btn btn--secondary btn--small" onClick={() => { void send(); }}>Retry</button>
        </>
      ) : (
        <button type="button" className="btn btn--secondary btn--small" disabled={busy} aria-label={p.projectName === undefined ? undefined : `Unarchive ${p.projectName}`} onClick={() => { void send(); }}>Unarchive</button>
      )}
    </span>
  );
}
