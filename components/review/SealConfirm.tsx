'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { DRAFT_PREFIX, openDraftStore, type DraftStore } from '@/lib/client/drafts';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import type { Stage } from '@/types/record';
import type { SealView } from '@/types/api';
import { FingerprintDisplay } from './FingerprintDisplay';
import { SEAL_STATUS, draftsHref, sealRefusal, sealedMessage, unsavedDraftsLine } from './reviewText';

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

/** This account's live drafts of the stage's questions in this project; it only reads (no probe, no write). */
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
 * S-17's confirmation (W-7, UX-18, FR-REV-03). First, when this account has unsaved answers of the stage on this
 * device, UX-18's line and "Go to them"; then what the seal will hold; then "Seal as seal N" and Cancel. The seal is
 * sent through route 13 with one request id for the page, so Retry after a lost reply returns the first seal (UX-27,
 * owner question B5). "Sealing..." and "Still sealing..." are polite; a failure is said once, assertively, with Retry
 * where retrying can help; a number another seal took reloads the page so the button shows the next number. On
 * success the confirmation is replaced by M-28 in a status region that takes focus, and the full fingerprint.
 */
export function SealConfirm(props: SealConfirmProps): ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const sealedRef = useRef<HTMLParagraphElement>(null);

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
    const { requestId, state } = requestIdFor(retry.current, {});
    retry.current = state;
    setPhase({ kind: 'sending', slow: false });
    const out = await sendWrite<SealView>(`/api/v1${base}/seals`, 'POST', { requestId }, {
      onSlow: () => setPhase((p) => (p.kind === 'sending' ? { kind: 'sending', slow: true } : p)),
    });
    if (out.kind === 'saved') { setPhase({ kind: 'sealed', seal: out.body }); return; }
    if (out.kind === 'not_saved') { setPhase({ kind: 'refused', message: SEAL_STATUS.lost, retry: true }); return; }
    const refusal = sealRefusal(out, props.sealNumber);
    setPhase({ kind: 'refused', message: refusal.message, retry: refusal.retry });
    if (refusal.refresh) {
      // Another seal took the number: a new request id, and the page reloads so the button and the preview show the next seal.
      retry.current = { requestId: null, sentBody: null };
      router.refresh();
    }
  }

  if (phase.kind === 'sealed') {
    return (
      <div>
        <p role="status" tabIndex={-1} ref={sealedRef}>{sealedMessage(phase.seal)}</p>
        <FingerprintDisplay fingerprint={phase.seal.fingerprint} />
        <p><a href={base}>Back to the review</a></p>
      </div>
    );
  }

  const line = unsavedDraftsLine(drafts);
  return (
    <div>
      {line !== null ? <p>{line} <a href={draftsHref(props.orgSlug, props.projectId, props.stage)}>Go to them</a></p> : null}
      {props.children}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
        <button type="button" className="btn btn--primary" aria-disabled={phase.kind === 'sending' || undefined} onClick={() => { void seal(); }}>
          {`Seal as seal ${props.sealNumber}`}
        </button>
        <a href={base} className="btn btn--secondary">Cancel</a>
      </div>
      <p role="status">{phase.kind === 'sending' ? (phase.slow ? SEAL_STATUS.slow : SEAL_STATUS.sending) : ''}</p>
      <div role="alert">
        {phase.kind === 'refused' ? (
          <p>{phase.message}{phase.retry ? <> <button type="button" className="btn btn--secondary" onClick={() => { void seal(); }}>Retry</button></> : null}</p>
        ) : null}
      </div>
    </div>
  );
}
