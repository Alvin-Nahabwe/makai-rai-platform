'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { revealFocused } from '@/components/ui/revealInView';
import '@/components/ui/textAreaStyles';
import './Documents.css';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { DOCUMENTS_COPY, DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { isKnownWithdrawMessage } from '@/lib/documents/generate';
import type { IssuedDocumentView } from '@/types/api';
import type { CalendarDate, DocumentType } from '@/types/record';

export type DocumentActionsProps = { orgSlug: string; document: IssuedDocumentView; canWithdraw: boolean };

const NO_RETRY: RetryState = { requestId: null, sentBody: null };
const documentUrl = (orgSlug: string, id: string, leaf: 'text' | 'withdrawal') => `/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(id)}/${leaf}`;

/** The lines of this slot. The withdrawal question is M-36 as owner question B2's default (no code, no checking sentence); the rest are queued for the owner. */
const W = DOCUMENTS_COPY.actions;
export const COPY_DONE = W.copied;
export const COPY_LOST = W.copyLost;
export const COPY_SIGNED_OUT = W.copySignedOut;
export const COPY_ERASED = W.copyErased;
export const COPY_TOO_MANY = W.copyTooMany;
export const COPY_OTHER = W.copyOther;
export const WITHDRAW_DONE = W.withdrawn;
export const WITHDRAW_TAKEN = W.withdrawTaken;
export const WITHDRAW_LOST = W.withdrawLost;   // M-06 pattern; the route replays on the request id
export const WITHDRAW_OTHER = W.withdrawOther;
export const WITHDRAW_SIGNED_OUT = W.withdrawSignedOut;
export const WITHDRAW_EARLIER = W.withdrawEarlier;
export const WITHDRAW_UNCONFIRMED = W.withdrawUnconfirmed;
export const WITHDRAW_FORBIDDEN = W.withdrawForbidden;
export const WITHDRAW_ARCHIVED = W.withdrawArchived;

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
  if (status === 409 && body.code === 'project_archived') return { kind: 'refused', line: WITHDRAW_ARCHIVED, retry: false };
  if (status === 401) return { kind: 'refused', line: WITHDRAW_SIGNED_OUT, retry: false };
  if (status === 403 && body.code === 'forbidden') return { kind: 'refused', line: WITHDRAW_FORBIDDEN, retry: false };
  // A field message the screen knows is shown; any other is never shown (the lead's ruling, G-c4).
  if (status === 422 && body.fields !== undefined && body.fields.length > 0 && isKnownWithdrawMessage(body.fields[0].message)) return { kind: 'refused', line: body.fields[0].message, retry: false };
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

/** M-36 as C#311 rules it: what withdrawing does. `_today` is no longer in the words (the lists show the date); the signature is kept for its callers. */
export const withdrawText = (type: DocumentType, _today: CalendarDate): string => W.withdrawConsequence(DOCUMENT_TITLES[type].toLowerCase());

/**
 * The copy when the clipboard is unavailable or refuses (an insecure page, a denied permission): the text in a read-only box, selected and
 * focused, so the person copies it by hand. The text is a value of a form control, never markup (NFR-SEC-11).
 */
export function CopyFallback({ text }: { text: string }): ReactElement {
  const id = useId();
  const box = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.focus();
    el.select();
    revealFocused(el);   // D-398 item 8: a focus() alone can leave the box cut by the window's edge
  }, []);
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>{W.selectAll}</label>
      <textarea className="ui-textarea ui-textarea--readonly" id={id} ref={box} readOnly rows={8} value={text} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
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
  useEffect(() => { box.current!.focus(); }, []);

  const retryButton = useRef<HTMLButtonElement | null>(null);
  const retried = useRef(false);

  async function send(fromRetry = false): Promise<void> {
    retried.current = fromRetry;
    setBusy(true);
    // A Retry keeps its line and stays, busy and focused, until the answer (D-398 item 4); a first send clears the line.
    if (!fromRetry) setFailure('');
    const out = await withdrawSend({ orgSlug: p.orgSlug, documentId: p.document.id, reason, retry, unknown });
    setBusy(false);
    setRetry(out.retry);
    setUnknown(out.unknown);
    if (out.result.kind === 'refused') { setFailure(out.result.line); setCanRetry(out.result.retry); return; }
    p.onDone(out.result.kind);
  }

  // A Retry that is no longer offered after its answer would leave focus on nothing: it goes to the reason.
  useEffect(() => {
    if (!busy && retried.current && !(failure !== '' && canRetry)) { retried.current = false; box.current?.focus(); }
  }, [busy, failure, canRetry]);

  return (
    <div data-inline-confirm>
      <InlineConfirm
        objectName={W.objectName(DOCUMENT_TITLES[p.document.documentType], formatUtcDay(p.document.issuedAt))}
        consequence={withdrawText(p.document.documentType, p.today)}
        actionLabel={W.withdraw}
        busy={busy}
        canConfirm={reason.trim() !== ''}
        onConfirm={() => send()}
        onCancel={p.onCancel}
        destructive
      >
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`withdraw-reason-${p.document.id}`}>{W.reasonLabel}</label>
          <textarea className="ui-textarea" id={`withdraw-reason-${p.document.id}`} ref={box} rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </InlineConfirm>
      <p role="alert" className="documents-line">{failure}</p>
      {failure !== '' && canRetry
        ? <Button variant="secondary" ref={retryButton} busy={busy} onClick={() => { void send(true); }}>{W.retry}</Button>
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
        <div className="document-actions__buttons">
          {p.document.erased === null ? <Button variant="secondary" ref={copyButton} busy={copying} onClick={() => { void copy(); }}>{W.copy}</Button> : null}
          {canWithdraw ? <Button variant="secondary" ref={trigger} onClick={() => { setToday(new Date().toISOString().slice(0, 10)); setStatus(''); setOpen(true); }}>{W.withdraw}</Button> : null}
        </div>
      )}
      <p role="status" className="documents-line">{status}</p>
      <p role="alert" className="documents-line">{alert}</p>
      {fallback === null ? null : <CopyFallback text={fallback} />}
    </div>
  );
}
