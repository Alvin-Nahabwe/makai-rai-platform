'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState } from '@/lib/client/retrySafeWrite';
import { DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { MSG_ARCHIVED, MSG_SIGNED_OUT } from '@/lib/documents/generate';
import type { IssuedDocumentView } from '@/types/api';
import type { CalendarDate, DocumentType } from '@/types/record';

export type DocumentActionsProps = { orgSlug: string; document: IssuedDocumentView; canWithdraw: boolean };

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const documentUrl = (orgSlug: string, id: string, leaf: 'text' | 'withdrawal') => `/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(id)}/${leaf}`;

/** The lines of this slot. The withdrawal question is M-36 as owner question B2's default (no code, no checking sentence); the rest are queued for the owner. */
export const COPY_DONE = 'Copied.';
export const COPY_LOST = 'Not copied: connection lost.';
export const WITHDRAW_DONE = 'Withdrawn.';
export const WITHDRAW_LOST = 'Not withdrawn yet: no reply from the server. It may have arrived. Retry is safe: it will not withdraw twice.';   // M-06 pattern; the route replays on the request id
export const WITHDRAW_OTHER = 'Not withdrawn. Reload the page and try again.';
export const WITHDRAW_SIGNED_OUT = MSG_SIGNED_OUT.replace('Not generated', 'Not withdrawn').replace(' Nothing was issued.', '');

/** M-36: what withdrawing says it will do. `today` is the UTC day of the withdrawal (documents print UTC, SRS 5.3 item 5). */
export const withdrawText = (type: DocumentType, today: CalendarDate): string =>
  `Withdraw ${DOCUMENT_TITLES[type].toLowerCase()}? It will show 'Withdrawn by the team on ${formatUtcDay(today)}'. The document stays stored.`;

/**
 * The copy when the clipboard is unavailable or refuses (an insecure page, a denied permission): the text in a read-only box, selected and
 * focused, so the person copies it by hand. The text is a value of a form control, never markup (NFR-SEC-11).
 */
export function CopyFallback({ text }: { text: string }): ReactElement {
  const id = useId();
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, []);
  return (
    <div className="form-group">
      <label htmlFor={id}>Select all and copy</label>
      <textarea id={id} ref={box} readOnly rows={8} value={text} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

/**
 * M-36 in place (UX-29): names the document, says what withdrawing does, takes the required reason, and its button repeats the action.
 * The reason is sent once per unchanged text, with one request id (a Retry resends it, UX-27).
 */
export function WithdrawConfirm(p: {
  orgSlug: string; document: IssuedDocumentView; reason?: string; today: CalendarDate; onDone: () => void; onCancel: () => void;
}): ReactElement {
  const [reason, setReason] = useState(p.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [retry, setRetry] = useState<RetryState>(NO_RETRY);
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { box.current?.focus(); }, []);

  async function send(): Promise<void> {
    const body = { reason };
    const id = requestIdFor(retry, body);
    setRetry(id.state);
    setBusy(true);
    setFailure('');
    const outcome = await sendWrite<IssuedDocumentView>(documentUrl(p.orgSlug, p.document.id, 'withdrawal'), 'POST', { ...body, requestId: id.requestId }, { onSlow: () => {} });
    setBusy(false);
    if (outcome.kind === 'saved') { p.onDone(); return; }
    if (outcome.kind === 'not_saved') { setFailure(WITHDRAW_LOST); setCanRetry(true); return; }
    const { status, body: error } = outcome;
    setCanRetry(status >= 500);
    if (status === 409 && error.code === 'already_withdrawn') { p.onDone(); return; }   // someone else withdrew it first; the list shows their reason
    if (status === 409 && error.code === 'project_archived') setFailure(MSG_ARCHIVED);
    else if (status === 401) setFailure(WITHDRAW_SIGNED_OUT);
    else if (status === 422 && error.fields !== undefined && error.fields.length > 0) setFailure(error.fields[0].message);
    else setFailure(WITHDRAW_OTHER);
  }

  return (
    <div data-inline-confirm>
      <InlineConfirm
        objectName={`${DOCUMENT_TITLES[p.document.documentType]} issued ${formatUtcDay(p.document.issuedAt)}`}
        consequence={withdrawText(p.document.documentType, p.today)}
        actionLabel="Withdraw document"
        busy={busy}
        canConfirm={reason.trim() !== ''}
        onConfirm={send}
        onCancel={p.onCancel}
      >
        <div className="form-group">
          <label htmlFor={`withdraw-reason-${p.document.id}`}>Reason (required)</label>
          <textarea id={`withdraw-reason-${p.document.id}`} ref={box} rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </InlineConfirm>
      <p role="alert">{failure}</p>
      {failure !== '' && canRetry
        ? <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { void send(); }}>Retry</button>
        : null}
    </div>
  );
}

/**
 * "Copy as text" and "Withdraw" for one issued document (FR-DOC-06, FR-DOC-07, UX-29; slot of S-18). Copy fetches route 18 and writes the
 * text to the clipboard; when that is not possible the text is shown in a read-only box instead. Withdraw (owners and admins, a document not
 * yet withdrawn) opens the confirmation in place; focus moves into it, and back to the button on Cancel.
 */
export function DocumentActions(p: DocumentActionsProps): ReactElement {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [alert, setAlert] = useState('');
  const [fallback, setFallback] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<CalendarDate>('');
  const trigger = useRef<HTMLButtonElement | null>(null);
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const done = useRef(false);

  useEffect(() => {
    if (!open && wasOpen.current) (done.current ? copyButton : trigger).current?.focus();
    wasOpen.current = open;
  }, [open]);

  async function copy(): Promise<void> {
    setStatus('');
    setAlert('');
    setFallback(null);
    let text: string;
    try {
      const res = await fetch(documentUrl(p.orgSlug, p.document.id, 'text'));
      if (!res.ok) throw new Error(`text route answered ${res.status}`);
      text = await res.text();
    } catch {
      setAlert(COPY_LOST);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus(COPY_DONE);
    } catch {
      // No clipboard on this page, or the browser refused: the text is shown for copying by hand.
      setFallback(text);
    }
  }

  const canWithdraw = p.canWithdraw && p.document.withdrawn === null;
  return (
    <div className="document-actions">
      {open ? (
        <WithdrawConfirm
          orgSlug={p.orgSlug} document={p.document} today={today}
          onDone={() => { done.current = true; setOpen(false); setStatus(WITHDRAW_DONE); router.refresh(); }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <div className="form-actions">
          {p.document.erased === null ? <button type="button" ref={copyButton} className="btn btn--secondary" onClick={() => { void copy(); }}>Copy as text</button> : null}
          {canWithdraw ? <button type="button" ref={trigger} className="btn btn--secondary" onClick={() => { setToday(new Date().toISOString().slice(0, 10)); setStatus(''); setOpen(true); }}>Withdraw document</button> : null}
        </div>
      )}
      <p role="status">{status}</p>
      <p role="alert">{alert}</p>
      {fallback === null ? null : <CopyFallback text={fallback} />}
    </div>
  );
}
