'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { DRAFT_PREFIX, openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import type { Stage } from '@/types/record';
import type { SealView } from '@/types/api';
import { FingerprintDisplay } from './FingerprintDisplay';
import { SEAL_STATUS, draftsHref, isSealBody, sealRefusal, sealedMessage, unsavedDraftsLine } from './reviewText';
import { Button, ButtonLink } from '@/components/ui/Button';
import '@/components/ui/formStyles';
import { REVIEW_COPY } from '@/lib/review/copy';
import './review.css';
import { clearRetry, loadRetry, retryAfter, saveRetry, sealRetryKey, sessionRetryStorage } from './retryStore';

export type SealConfirmProps = {
  orgSlug: string; projectId: string; reviewId: string; stage: Stage; sealNumber: number;
  /** The signed-in account and its organisation: only this account's drafts are counted (UX-26, obligation B11). */
  userId: string; orgId: string;
  /** The question ids of the stage, so a draft of another stage is not counted (DraftKey holds the question only). */
  questionIds: string[];
  /** What the seal will hold, rendered by the page. */
  children: ReactNode;
};

/** The draft store's own probe key (lib/client/drafts.ts), written and removed each time a store is opened. */
const PROBE_KEY = `${DRAFT_PREFIX}probe`;

/**
 * Whether a storage event can change the draft count: a draft key, or a cleared storage (key null). The probe key and
 * every other key are ignored, so another tab opening its draft store cannot make this tab read again (C4 SF-2).
 */
export function isDraftStorageEvent(key: string | null): boolean {
  return key === null || (key.startsWith(DRAFT_PREFIX) && key !== PROBE_KEY);
}

/** This account's live drafts of the stage's questions in this project. It opens nothing and writes no probe; the store's `list` may remove an expired draft. */
export function countStageDrafts(
  store: DraftStore | null, now: Date, f: { userId: string; orgId: string; projectId: string; questionIds: readonly string[] },
): number {
  if (store === null) return 0;   // no storage on this device: there can be no draft to count
  const ofStage = new Set(f.questionIds);
  return store.list(f.userId, now, { orgId: f.orgId, projectId: f.projectId })
    .filter((d) => d.key.target.kind === 'question' && ofStage.has(d.key.target.questionId)).length;
}

function subscribeStorage(onChange: () => void): () => void {
  const listener = (e: StorageEvent) => { if (isDraftStorageEvent(e.key)) onChange(); };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

type Phase =
  | { kind: 'idle' } | { kind: 'sending'; slow: boolean }
  | { kind: 'refused'; message: string; retry: boolean } | { kind: 'sealed'; seal: SealView };

/**
 * S-17's confirmation (W-7, UX-18, FR-REV-03). First, when this account has unsaved decisions of the stage in this
 * browser, UX-18's line and its link; then what the seal will include; then "Seal now" and Cancel. The seal is
 * sent through route 13 with one request id for the page, so Retry after a lost reply returns the first seal (UX-27,
 * owner question B5). "Sealing..." and "Still sealing..." are polite; a failure is said once, assertively, with Retry
 * where retrying can help; a number another seal took reloads the page so the button shows the next number. On
 * success the confirmation is replaced by M-28 in a status region that takes focus, and the full fingerprint.
 */
export function SealConfirm(props: SealConfirmProps): ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The request id survives a reload in this tab (sessionStorage), so a press after a lost reply replays it (hunter H1).
  const retry = useRef<RetryState | null>(null);
  const retryKey = sealRetryKey(props.userId, props.reviewId);
  const sealedRef = useRef<HTMLParagraphElement>(null);
  // Retry unmounts with the alert it sits in, so focus goes back to the seal button (S-17 hunt H6).
  const sealButtonRef = useRef<HTMLButtonElement>(null);

  // The draft store is opened once per mount (its probe write is a storage event in every other tab), null on the
  // server; the count is read from it after hydration (0 on the server) and again when a draft key changes in another tab.
  const [store] = useState<DraftStore | null>(() => (typeof window === 'undefined' ? null : openDraftStore()));
  const drafts = useSyncExternalStore(
    subscribeStorage,
    () => countStageDrafts(store, new Date(), { userId: props.userId, orgId: props.orgId, projectId: props.projectId, questionIds: props.questionIds }),
    () => 0,
  );

  useEffect(() => { if (phase.kind === 'sealed') sealedRef.current?.focus(); }, [phase.kind]);

  const base = `/orgs/${encodeURIComponent(props.orgSlug)}/projects/${encodeURIComponent(props.projectId)}/reviews/${encodeURIComponent(props.reviewId)}`;

  async function seal(): Promise<void> {
    if (phase.kind === 'sending') return;
    const stored = retry.current ?? loadRetry(sessionRetryStorage(), retryKey);
    const { requestId, state } = requestIdFor(stored, {});
    retry.current = state;
    saveRetry(sessionRetryStorage(), retryKey, state);   // before sending: a reload during or after the send reuses it
    setPhase({ kind: 'sending', slow: false });
    const out = await sendWrite<SealView>(`/api/v1${base}/seals`, 'POST', { requestId }, {
      onSlow: () => setPhase((p) => (p.kind === 'sending' ? { kind: 'sending', slow: true } : p)),
    });
    const ok = out.kind === 'saved' && isSealBody(out.body);
    if (retryAfter(out.kind === 'rejected' ? { kind: 'rejected', status: out.status, code: out.body.code } : out.kind === 'saved' ? { kind: 'saved', bodyOk: ok } : { kind: 'not_saved' }) === 'clear') {
      retry.current = { requestId: null, sentBody: null };
      clearRetry(sessionRetryStorage(), retryKey);
    }
    if (out.kind === 'saved' && ok) { setPhase({ kind: 'sealed', seal: out.body as SealView }); return; }
    // A 2xx that is not a seal says nothing sure: the same id is kept, so Retry replays whatever was written.
    if (out.kind === 'saved' || out.kind === 'not_saved') { setPhase({ kind: 'refused', message: SEAL_STATUS.lost, retry: true }); return; }
    const refusal = sealRefusal(out, props.sealNumber);
    setPhase({ kind: 'refused', message: refusal.message, retry: refusal.retry });
    // Another seal took the number: the page reloads so the button and the preview show the next seal.
    if (refusal.refresh) router.refresh();
  }

  const c = REVIEW_COPY.confirm;
  if (phase.kind === 'sealed') {
    return (
      <div className="review-seal">
        <p role="status" tabIndex={-1} ref={sealedRef} className="ui-status review-sealed">{sealedMessage(phase.seal)}</p>
        <FingerprintDisplay fingerprint={phase.seal.fingerprint} />
        <p><a href={base}>{c.back}</a></p>
      </div>
    );
  }

  const line = unsavedDraftsLine(drafts);
  return (
    <div className="review-seal">
      {line !== null ? <p>{line} <a href={draftsHref(props.orgSlug, props.projectId, props.stage)}>{c.unsavedLink}</a></p> : null}
      {props.children}
      <div className="review-row">
        <Button variant="primary" ref={sealButtonRef} busy={phase.kind === 'sending'} onClick={() => { void seal(); }}>{c.sealNow}</Button>
        <ButtonLink variant="secondary" href={base}>{c.cancel}</ButtonLink>
      </div>
      <p role="status" className="ui-status">{phase.kind === 'sending' ? (phase.slow ? SEAL_STATUS.slow : SEAL_STATUS.sending) : ''}</p>
      <div role="alert" className="ui-status">
        {phase.kind === 'refused' ? (
          <p className="review-alert">{phase.message}{phase.retry ? <> <Button variant="secondary" onClick={() => { sealButtonRef.current?.focus(); void seal(); }}>{c.retry}</Button></> : null}</p>
        ) : null}
      </div>
    </div>
  );
}
