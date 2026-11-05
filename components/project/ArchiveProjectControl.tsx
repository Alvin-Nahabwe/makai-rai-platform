'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { signInAgainHref } from '@/lib/auth/idle';

const FRESH: RetryState = { requestId: null, sentBody: null };
const ARCHIVED_LINE = 'Archived. Nothing in this project can be changed until it is unarchived.';

/**
 * The Archive control of S-10 (FR-PRJ-03, UX-29, UX-27; SRS 7.4.2 row S-10). The button opens an inline confirmation
 * that names the project and what archiving does; confirming sends route 21 with a request id that a Retry repeats
 * (a request that had arrived is answered again, not refused). One `role="status"` line says what became of it, and
 * it stays across the `router.refresh()` that follows: this component keeps its place in the tree, so it also stays
 * mounted once the project is archived, with its button gone.
 */
export function ArchiveProjectControl(p: { orgSlug: string; projectId: string; projectName: string; archived: boolean }): ReactElement | null {
  const router = useRouter();
  const retry = useRef<RetryState>(FRESH);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  // UX-42: focus moves to the confirmation when it opens.
  useEffect(() => { if (confirming) confirmation.current?.focus(); }, [confirming]);

  async function send(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setConfirming(false);
    setCanRetry(false);
    setStatus('Archiving...');
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    const outcome = await sendWrite(`/api/v1/orgs/${p.orgSlug}/projects/${p.projectId}/archive`, 'POST', { requestId }, { onSlow: () => setStatus('Still saving. The connection is slow.') });
    setBusy(false);
    if (outcome.kind === 'not_saved') {
      // Keep the id: a Retry sends the same request, which the server answers again if it had arrived.
      setStatus('Not archived: connection lost.');
      setCanRetry(true);
      return;
    }
    if (outcome.kind === 'saved' || (outcome.kind === 'rejected' && outcome.status === 409 && outcome.body.code === 'already_archived')) {
      retry.current = FRESH;
      setStatus(ARCHIVED_LINE);
    } else if (outcome.status === 401) {
      window.location.assign(signInAgainHref(window.location.pathname, window.location.search));   // the session ended: sign in, then come back
      return;
    } else if (outcome.status === 403 || outcome.status === 404) {
      retry.current = FRESH;   // the same request would be refused again
      setStatus(outcome.status === 403 ? 'You can no longer change this project.' : 'This project no longer exists.');
    } else if (outcome.status === 409) {
      retry.current = FRESH;
      setStatus(null);   // another state: the refreshed page shows what applies now
    } else {
      // A server error or a limit: say so, keep the id, and let the person try again.
      setStatus('Not archived: something went wrong. Please try again.');
      setCanRetry(true);
      return;
    }
    router.refresh();
  }

  function cancel(): void {
    setConfirming(false);
    trigger.current?.focus();
  }

  if (p.archived && status === null) return null;
  return (
    <div className="archive-control">
      {!p.archived && !busy && !canRetry ? (
        <button ref={trigger} type="button" className="btn btn--secondary" onClick={() => setConfirming(true)}>Archive project</button>
      ) : null}
      {!p.archived && confirming ? (
        <div ref={confirmation} tabIndex={-1}>
          <InlineConfirm
            objectName={`Archive ${p.projectName}?`}
            consequence="Nothing in it can be changed until it is unarchived. No reminders are sent. Its issued documents stay stored and can still be downloaded."
            actionLabel="Archive project"
            onConfirm={send}
            onCancel={cancel}
            busy={busy}
          />
        </div>
      ) : null}
      <p role="status">{status}</p>
      {canRetry ? <button type="button" className="btn btn--secondary" onClick={() => { void send(); }}>Retry</button> : null}
    </div>
  );
}
