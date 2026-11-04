'use client';

import { useRouter } from 'next/navigation';
import type { ReactElement } from 'react';
import { KEPT_IN_FORM } from '@/lib/findings/formRules';
import { useFindingWrite } from '@/components/findings/FindingActions';

export type CloseByDecisionButtonProps = {
  orgSlug: string; projectId: string; findingId: string; decisionVersionId: string;
  reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; findingTitle: string;
};

/**
 * "Close it: decision changed" or "Close it: decision withdrawn" (FR-FND-06, FR-DEC-08, UX-15): the one action that closes a
 * shortfall finding by the decision that resolved it, posted to route 11. Nothing closes without this press. A 201 or 200
 * refreshes the page; a 409 `finding_not_open` shows 7.4.4's sentence from the answer.
 */
export function CloseByDecisionButton(p: CloseByDecisionButtonProps): ReactElement {
  const router = useRouter();
  const url = `/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}/close-by-decision`;
  const w = useFindingWrite(url, KEPT_IN_FORM);
  const label = p.reason === 'decision_withdrawn' ? 'Close it: decision withdrawn' : 'Close it: decision changed';
  return (
    <div>
      <button
        type="button" className="btn btn--secondary btn--small" disabled={w.phase !== 'idle'}
        aria-label={`${label}. Finding: ${p.findingTitle}`}
        onClick={async () => { if (await w.send({ decisionVersionId: p.decisionVersionId })) router.refresh(); }}
      >{label}</button>
      <span role="status">{w.phase === 'saving' ? 'Closing...' : w.phase === 'slow' ? 'Still saving. The connection is slow.' : ''}</span>
      {w.failure === null ? null : <span role="alert">{w.failure.text}</span>}
    </div>
  );
}
