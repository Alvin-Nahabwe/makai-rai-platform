'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { MSG_ARCHIVED } from '@/lib/documents/generate';
import type { IssuedDocumentView } from '@/types/api';
import type { CalendarDate, DocumentType } from '@/types/record';

export type DocumentActionsProps = { orgSlug: string; document: IssuedDocumentView; canWithdraw: boolean };

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const documentUrl = (orgSlug: string, id: string, leaf: 'text' | 'withdrawal') => `/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(id)}/${leaf}`;

/** The lines of this slot. The withdrawal question is M-36 as owner question B2's default (no code, no checking sentence); the rest are queued for the owner. */
export const COPY_DONE = 'Copied.';
export const COPY_LOST = 'Not copied: connection lost.';
export const COPY_SIGNED_OUT = 'Not copied: you are signed out. Sign in again, then come back.';
export const COPY_ERASED = "Not copied: this document's text was erased.";
export const COPY_TOO_MANY = 'Not copied: too many requests. Wait a minute, then try again.';
export const COPY_OTHER = 'Not copied. Reload the page and try again.';
export const WITHDRAW_DONE = 'Withdrawn.';
export const WITHDRAW_TAKEN = 'Not withdrawn by you: someone else withdrew it first. Their reason is shown.';
export const WITHDRAW_LOST = 'Not withdrawn yet: no reply from the server. It may have arrived. Retry is safe: it will not withdraw twice.';   // M-06 pattern; the route replays on the request id
export const WITHDRAW_OTHER = 'Not withdrawn. Reload the page and try again.';
export const WITHDRAW_SIGNED_OUT = 'Not withdrawn: you are signed out. Sign in again, then come back.';
export const WITHDRAW_EARLIER = 'Withdrawn. Your earlier request may have done it; the reason shown is the one recorded.';
export const WITHDRAW_UNCONFIRMED = 'Not confirmed: it may already have been withdrawn. Reload the page to see.';
export const WITHDRAW_FORBIDDEN = 'Not withdrawn: your role in this organisation no longer allows this. Ask an owner or admin.';

export type WithdrawResult = { kind: 'done' } | { kind: 'taken' } | { kind: 'earlier' } | { kind: 'refused'; line: string; retry: boolean };

/**
 * What a withdrawal's reply means for the person. A reply that does not say the withdrawal failed (no reply, a gateway page, a 5xx) may have
 * landed, so it gets the M-06 line and a Retry that resends the same request id; "Nothing was changed" is not said for any of them.
 * `unknown` is true when the person's last send ended that way: until a definite answer comes, a 409 already_withdrawn may be their own
 * earlier request (not "someone else"), and a 401 or 403 does not show that nothing happened.
 */
function withdrawResult(outcome: SendOutcome<unknown>, unknown: boolean): WithdrawResult {
  if (outcome.kind === 'saved') return { kind: 'done' };
  if (outcome.kind === 'not_saved') return { kind: 'refused', line: WITHDRAW_LOST, retry: true };
  const { status, body } = outcome;
  if (status >= 500) return { kind: 'refused', line: WITHDRAW_LOST, retry: true };
  if (status === 409 && body.code === 'already_withdrawn') return { kind: unknown ? 'earlier' : 'taken' };
  if (unknown && (status === 401 || status === 403)) return { kind: 'refused', line: WITHDRAW_UNCONFIRMED, retry: false };
  if (status === 409 && body.code === 'project_archived') return { kind: 'refused', line: MSG_ARCHIVED, retry: false };
  if (status === 401) return { kind: 'refused', line: WITHDRAW_SIGNED_OUT, retry: false };
  if (status === 403 && body.code === 'forbidden') return { kind: 'refused', line: WITHDRAW_FORBIDDEN, retry: false };
  if (status === 422 && body.fields !== undefined && body.fields.length > 0) return { kind: 'refused', line: body.fields[0].message, retry: false };
  return { kind: 'refused', line: WITHDRAW_OTHER, retry: false };
}

/** True when the outcome leaves it unknown whether the withdrawal landed. */
const isUnknown = (outcome: SendOutcome<unknown>): boolean => outcome.kind === 'not_saved' || (outcome.kind === 'rejected' && outcome.status >= 500);

/** Sends one withdrawal with the request id `retry` calls for (the same id for an unchanged reason). Returns what it means and the state to keep. */
export async function withdrawSend(a: { orgSlug: string; documentId: string; reason: string; retry: RetryState; unknown?: boolean; fetchImpl?: typeof fetch }): Promise<{ result: WithdrawResult; retry: RetryState; unknown: boolean }> {
  const body = { reason: a.reason };
  const id = requestIdFor(a.retry, body);
  const outcome = await sendWrite<IssuedDocumentView>(documentUrl(a.orgSlug, a.documentId, 'withdrawal'), 'POST', { ...body, requestId: id.requestId }, { onSlow: () => {}, fetchImpl: a.fetchImpl });
  return { result: withdrawResult(outcome, a.unknown ?? false), retry: id.state, unknown: isUnknown(outcome) };
}

export type CopyResult = { kind: 'copied' } | { kind: 'fallback'; text: string } | { kind: 'refused'; line: string; erased: boolean };

/** Fetches route 18 and writes the text to the clipboard. A refusal names its cause; a clipboard that is missing or refuses gives the text for copying by hand. */
export async function copyDocumentText(a: { orgSlug: string; documentId: string; fetchImpl?: typeof fetch; clipboard?: { writeText(text: string): Promise<void> } }): Promise<CopyResult> {
  let res: Response;
  try {
    res = await (a.fetchImpl ?? fetch)(documentUrl(a.orgSlug, a.documentId, 'text'));
  } catch {
    return { kind: 'refused', line: COPY_LOST, erased: false };
  }
  if (!res.ok) {
    if (res.status === 401) return { kind: 'refused', line: COPY_SIGNED_OUT, erased: false };
    if (res.status === 410) return { kind: 'refused', line: COPY_ERASED, erased: true };
    if (res.status === 429) return { kind: 'refused', line: COPY_TOO_MANY, erased: false };
    return { kind: 'refused', line: COPY_OTHER, erased: false };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'refused', line: COPY_LOST, erased: false };   // the body did not arrive
  }
  try {
    if (a.clipboard === undefined) throw new Error('no clipboard');
    await a.clipboard.writeText(text);
    return { kind: 'copied' };
  } catch {
    // No clipboard on this page, or the browser refused: the text is shown for copying by hand.
    return { kind: 'fallback', text };
  }
}

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

type Scrolls = { scrollIntoView?: (o?: ScrollIntoViewOptions) => void };

/**
 * Opens the withdrawal confirmation into view (SC 2.4.11, NFR-A11Y-02). focus() does not scroll a field that is already partly visible, so
 * near the end of a short page the confirmation opened with its field cut off and both of its buttons below the fold. So: the whole
 * confirmation is brought into view, the field is focused without a scroll of its own, and then the field itself is brought into view (a
 * no-op once the confirmation is in view; the guarantee for a window shorter than the confirmation). Each scroll is instant rather than the
 * page's smooth scroll (app/globals.css), as in DecisionForm's onFocus, so the confirmation is in view when focus lands. The optional call
 * is the precedent's own form: a test DOM may not implement scrollIntoView, and the field still takes focus.
 */
export function revealConfirmation(confirmation: Scrolls | null, field: Scrolls & { focus: (o?: FocusOptions) => void }): void {
  const instant: ScrollIntoViewOptions = { block: 'nearest', behavior: 'instant' };
  confirmation?.scrollIntoView?.(instant);
  field.focus({ preventScroll: true });
  field.scrollIntoView?.(instant);
}

/**
 * M-36 in place (UX-29): names the document, says what withdrawing does, takes the required reason, and its button repeats the action.
 * The reason is sent once per unchanged text, with one request id (a Retry resends it, UX-27).
 */
export function WithdrawConfirm(p: {
  orgSlug: string; document: IssuedDocumentView; reason?: string; today: CalendarDate; onDone: (how: 'done' | 'taken' | 'earlier') => void; onCancel: () => void;
}): ReactElement {
  const [reason, setReason] = useState(p.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [retry, setRetry] = useState<RetryState>(NO_RETRY);
  const [unknown, setUnknown] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (box.current) revealConfirmation(wrap.current, box.current); }, []);

  async function send(): Promise<void> {
    setBusy(true);
    setFailure('');
    const out = await withdrawSend({ orgSlug: p.orgSlug, documentId: p.document.id, reason, retry, unknown });
    setBusy(false);
    setRetry(out.retry);
    setUnknown(out.unknown);
    if (out.result.kind === 'refused') { setFailure(out.result.line); setCanRetry(out.result.retry); return; }
    p.onDone(out.result.kind);
  }

  return (
    <div data-inline-confirm ref={wrap}>
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
  const [copying, setCopying] = useState(false);
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
    setCopying(true);
    const out = await copyDocumentText({ orgSlug: p.orgSlug, documentId: p.document.id, clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard });
    setCopying(false);
    if (out.kind === 'copied') setStatus(COPY_DONE);
    else if (out.kind === 'fallback') setFallback(out.text);
    else {
      setAlert(out.line);
      if (out.erased) router.refresh();   // the list then shows the document as erased and drops this button
    }
  }

  const canWithdraw = p.canWithdraw && p.document.withdrawn === null;
  return (
    <div className="document-actions">
      {open ? (
        <WithdrawConfirm
          orgSlug={p.orgSlug} document={p.document} today={today}
          onDone={(how) => { done.current = true; setOpen(false); setStatus(how === 'done' ? WITHDRAW_DONE : how === 'earlier' ? WITHDRAW_EARLIER : WITHDRAW_TAKEN); router.refresh(); }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <div className="form-actions">
          {p.document.erased === null ? <button type="button" ref={copyButton} className="btn btn--secondary" disabled={copying} onClick={() => { void copy(); }}>Copy as text</button> : null}
          {canWithdraw ? <button type="button" ref={trigger} className="btn btn--secondary" onClick={() => { setToday(new Date().toISOString().slice(0, 10)); setStatus(''); setOpen(true); }}>Withdraw document</button> : null}
        </div>
      )}
      <p role="status">{status}</p>
      <p role="alert">{alert}</p>
      {fallback === null ? null : <CopyFallback text={fallback} />}
    </div>
  );
}
