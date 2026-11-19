'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { isReviewBody, sealRequestRefusal } from './reviewText';
import { retryAfter } from './retryStore';
import { Button, ButtonLink } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { TERM_SEAL } from '@/lib/vocabulary/terms';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { SealStepState } from '@/lib/review/sealStep';
import type { Stage } from '@/types/record';
import type { StageReviewView } from '@/types/api';
import './SealStep.css';

export type SealStepProps = { orgSlug: string; projectId: string; stage: Stage; state: SealStepState };

const C = REVIEW_COPY.sealStep;
const NO_ID: RetryState = { requestId: null, sentBody: null };

/**
 * The seal step under a stage page's heading (design G2 and §8; SRS FR-DOC-09 clause 10). `state` is the server's answer
 * (lib/review/sealStep.ts), so a role never sees a control it cannot use (design §4, anti-goal 4). "Ask a reviewer to
 * seal this stage" posts the seal request and then shows the waiting line in place of the button, with focus moved to it
 * so a keyboard or screen reader user is not left on a control that is gone. "Open and seal this stage" posts the same
 * request and goes to the review's seal page; "Seal this stage" is a link to that page, the existing seal flow. A damaged
 * latest seal says so first (fix round 1), then offers the role's control, if it has one.
 *
 * The request id is kept in memory until the request is answered, so pressing again after a lost reply sends the same
 * id; the request is idempotent per stage, so even a new id returns the review the first one opened.
 */
export function SealStep({ orgSlug, projectId, stage, state }: SealStepProps): ReactElement | null {
  const router = useRouter();
  const [asked, setAsked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [alert, setAlert] = useState('');
  const retry = useRef<RetryState>(NO_ID);
  const waitingRef = useRef<HTMLSpanElement>(null);
  const base = `/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}`;

  // After the request, the button is gone: focus moves to the line that replaced it.
  useEffect(() => {
    if (asked !== null) waitingRef.current?.focus();
  }, [asked]);

  async function send(button: string, then: (review: StageReviewView) => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setAlert('');
    setStatus(REVIEW_COPY.open.sending);
    const body = { stage };
    const { requestId, state: kept } = requestIdFor(retry.current, body);
    retry.current = kept;
    const out = await sendWrite<StageReviewView>(`/api/v1${base}/reviews/seal-request`, 'POST', { ...body, requestId }, { onSlow: () => setStatus(REVIEW_COPY.open.slow) });
    setStatus('');
    const ok = out.kind === 'saved' && isReviewBody(out.body);
    if (retryAfter(out.kind === 'rejected' ? { kind: 'rejected', status: out.status, code: out.body.code } : out.kind === 'saved' ? { kind: 'saved', bodyOk: ok } : { kind: 'not_saved' }) === 'clear') {
      retry.current = NO_ID;
    }
    if (out.kind === 'saved' && isReviewBody(out.body)) {
      then(out.body);
      return;
    }
    setBusy(false);
    // A 2xx that is not a review, or no reply: the review may be open, and pressing again returns it.
    if (out.kind !== 'rejected') {
      setAlert(C.lost(button));
      return;
    }
    const refusal = sealRequestRefusal(out, button);
    setAlert(refusal.message);
    if (refusal.refresh) router.refresh();
  }

  // After an ask (also the re-request on a damaged seal) the server's state is "waiting" on the review it returned.
  const askedFrom = state.kind === 'ask' || (state.kind === 'damaged' && state.action === 'ask');
  const shown: SealStepState = askedFrom && asked !== null ? { kind: 'waiting', reviewId: asked } : state;
  const askButton = (
    <Button variant="secondary" busy={busy} onClick={() => { void send(C.ask, (review) => { setBusy(false); setAsked(review.id); router.refresh(); }); }}>
      {C.ask}
    </Button>
  );
  const sealLink = (reviewId: string) => <ButtonLink variant="secondary" href={`${base}/reviews/${encodeURIComponent(reviewId)}/seal`}>{C.seal}</ButtonLink>;
  // Each state's first use of "seal" (the vocabulary defines it at first use) is marked as the term, with its (i) right
  // after it in the same line, never inside the control: the stage page's own pattern (its tally, StageLine's damage line).
  const firstUse = (words: ReactElement | string) => (
    <p className="seal-step__line"><Term of={TERM_SEAL}>{words}</Term><TermTip of={TERM_SEAL} label={C.whatMeans(TERM_SEAL.term)} /></p>
  );
  let step: ReactElement;
  switch (shown.kind) {
    case 'hidden':
      return null;
    case 'sealed':
      // "sealed" is not a use of the term "seal" (whole words, lib/vocabulary/firstUse.ts termPattern).
      step = <p className="seal-step__line">{C.sealed}</p>;
      break;
    case 'waiting':
      // A focus target after the request, as the project's other status lines are (role status, tabIndex -1); the (i)
      // sits after it, outside the status.
      step = firstUse(<span className="seal-step__status" role="status" ref={waitingRef} tabIndex={-1}>{C.waiting}</span>);
      break;
    case 'seal':
      step = firstUse(sealLink(shown.reviewId));
      break;
    case 'ask':
      step = firstUse(askButton);
      break;
    case 'open_and_seal':
      step = firstUse(
        // Still busy while the seal page loads, so the button cannot send again.
        <Button variant="secondary" busy={busy} onClick={() => { void send(C.openAndSeal, (review) => { router.push(`${base}/reviews/${encodeURIComponent(review.id)}/seal`); }); }}>
          {C.openAndSeal}
        </Button>,
      );
      break;
    case 'damaged':
      // The damage is said first, in the words the review and project pages use (reviewStateLine); it is the step's first
      // use of "seal", so the control after it carries no second (i).
      step = (
        <>
          {firstUse(REVIEW_COPY.state.damaged)}
          {shown.action === 'seal' ? <p className="seal-step__line">{sealLink(shown.reviewId)}</p> : null}
          {shown.action === 'ask' ? <p className="seal-step__line">{askButton}</p> : null}
        </>
      );
      break;
  }
  return (
    <div className="seal-step" data-seal-step={shown.kind}>
      {step}
      <StatusRegion message={status} />
      <StatusRegion message={alert} politeness="assertive" tone="error" />
    </div>
  );
}
