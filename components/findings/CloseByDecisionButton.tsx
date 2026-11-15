'use client';

import { useRouter } from 'next/navigation';
import type { ReactElement } from 'react';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { FailureText, useFindingWrite } from '@/components/findings/FindingActions';
import '@/components/ui/buttonStyles';

export type CloseByDecisionButtonProps = {
  orgSlug: string; projectId: string; findingId: string; decisionVersionId: string;
  reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; findingTitle: string;
};

const C = FINDINGS_COPY.closeByDecision;

/**
 * "Close finding" (FR-FND-06, FR-DEC-08, UX-15): the one action that closes a shortfall finding by the decision that
 * resolved it, posted to route 11. Nothing closes without this press. A 201 or 200 refreshes the page; a 409
 * `finding_not_open` shows 7.4.4's sentence from the answer, and a 409 `finding_has_open_work` (a mitigation became
 * Planned or In progress after the page loaded; R11) the close box's sentence. Nothing is typed here, so a failure says
 * nothing about kept words.
 *
 * A native button in the kit's classes: it needs `aria-label` (the finding's title, so a list of them is told apart),
 * which the kit's Button does not take. While its request is in flight it is `aria-busy`, never `disabled`, so the person
 * who pressed it keeps focus; `useFindingWrite` refuses a second press.
 */
export function CloseByDecisionButton(p: CloseByDecisionButtonProps): ReactElement {
  const router = useRouter();
  const url = `/api/v1/orgs/${encodeURIComponent(p.orgSlug)}/projects/${encodeURIComponent(p.projectId)}/findings/${encodeURIComponent(p.findingId)}/close-by-decision`;
  const w = useFindingWrite(url, '', C.label);
  const busy = w.phase !== 'idle';
  return (
    <div className="finding-close">
      <button
        type="button" className="ui-button ui-button--secondary ui-button--compact" aria-busy={busy ? true : undefined}
        aria-label={C.ariaLabel(p.findingTitle)}
        onClick={async () => { if (await w.send({ decisionVersionId: p.decisionVersionId })) router.refresh(); }}
      >{busy ? <span className="ui-button__spinner" aria-hidden="true" /> : null}{C.label}</button>
      <span role="status">{w.phase === 'saving' ? C.closing : w.phase === 'slow' ? C.slow : ''}</span>
      {w.failure === null ? null : <span role="alert" className="finding-alert"><FailureText text={w.failure.text} name={w.failure.nameInText} /></span>}
    </div>
  );
}
