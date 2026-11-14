'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, Ref, RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { sendWrite, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/TextInput';
import { MAX_LEGAL_NAME } from '@/lib/admin/limits';
import { ADMIN_FORMS_COPY } from '@/lib/admin/forms/copy';
import './AdminForms.css';

const L = ADMIN_FORMS_COPY.legalName;

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<{ previousLegalName: string | null }>>;

const FIELD_MARKED = L.fieldMarked;
/** Said when the value is already the legal name: refused before sending, or answered 200 by the route (nothing written). */
export const UNCHANGED_LEGAL_NAME = L.unchanged;

/** The form after Cancel: closed, and neither the value, the field error nor the status sentence that pointed at the field is kept. */
export function cancelledForm(legalName: string | null): { open: false; error: undefined; value: string; status: '' } {
  return { open: false, error: undefined, value: legalName ?? '', status: '' };
}

/** The field error for a new legal name, or undefined when it may be sent (an unchanged value is not sent, as for the name). */
export function correctLegalNameError(value: string, current: string | null): string | undefined {
  const next = value.trim();
  if (next === '') return L.missing;
  if (next.length > MAX_LEGAL_NAME) return L.tooLong(MAX_LEGAL_NAME);
  if (next === current) return UNCHANGED_LEGAL_NAME;
  return undefined;
}

/**
 * What came of correcting the legal name. `invalid` is a message for the input itself; `done` is a sentence for the
 * form's status region, `saved` telling whether the value was written. Only `{ legalName }` is ever sent: the parser's
 * "one at a time" error arrives on field `name`, so any 422 that does not name `legalName` is a form-level sentence.
 */
export async function correctLegalName(
  value: string, current: string | null, send: Send,
): Promise<{ kind: 'invalid'; error: string } | { kind: 'done'; status: string; saved: boolean; unchanged?: true }> {
  const error = correctLegalNameError(value, current);
  if (error !== undefined) return { kind: 'invalid', error };
  const next = value.trim();
  const out = await send({ legalName: next });
  if (out.kind === 'saved') {
    // The route answers 200 and writes nothing for a value the organisation already has (the page was stale).
    if (out.body.previousLegalName === next) return { kind: 'done', saved: false, unchanged: true, status: UNCHANGED_LEGAL_NAME };
    const status = out.body.previousLegalName === null ? L.savedFirst(next) : L.saved(next, out.body.previousLegalName);
    return { kind: 'done', saved: true, status };
  }
  if (out.kind === 'not_saved') return { kind: 'done', saved: false, status: L.lostReply };
  const fieldError = out.body.code === 'validation' ? out.body.fields?.find((f) => f.field === 'legalName') : undefined;
  if (fieldError !== undefined) return { kind: 'invalid', error: fieldError.message };
  return { kind: 'done', saved: false, status: out.status === 401 ? L.signedOut : L.other };
}

export type CorrectLegalNameViewProps = {
  formId: string; open: boolean; value: string; error: string | undefined; status: string; busy: boolean;
  statusRef?: RefObject<HTMLDivElement | null>;
  /** The field, which takes focus when the form opens, and "Change the legal name", which takes it back on Cancel (ruling L5-14). */
  fieldRef?: Ref<HTMLInputElement>;
  triggerRef?: Ref<HTMLButtonElement>;
  onOpen: () => void; onValue: (v: string) => void; onSubmit: () => void; onCancel: () => void;
};

/**
 * The correction as markup. The status region is mounted from the first render, so the success and failure sentences
 * put in it are announced (4.1.3); the input has a visible label and its hint, tied by aria-describedby (the error,
 * when there is one, is tied the same way and the input takes focus).
 */
export function CorrectLegalNameView({ formId, open, value, error, status, busy, statusRef, fieldRef, triggerRef, onOpen, onValue, onSubmit, onCancel }: CorrectLegalNameViewProps): ReactElement {
  return (
    <div className="admin-block">
      <div role="status" tabIndex={-1} ref={statusRef} className="ui-status">{status}</div>
      {!open ? (
        <Button ref={triggerRef} variant="secondary" onClick={onOpen}>{L.change}</Button>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          <TextInput ref={fieldRef} id={`${formId}-legal-name`} name="legalName" label={L.label} hint={L.hint} error={error} required
            maxLength={MAX_LEGAL_NAME} autoComplete="off" value={value} onChange={(e) => onValue(e.target.value)} />
          <div className="admin-form__actions">
            <Button variant="primary" type="submit" busy={busy}>{L.save}</Button>
            <Button variant="secondary" onClick={onCancel}>{L.cancel}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * S-24's legal-name change (FR-ORG-10; route 42 with `{ legalName }`), beside the name change. Focus (ruling L5-14):
 * the form opens on its field, and Cancel gives focus back to "Change the legal name".
 */
export function CorrectLegalNameForm({ orgId, legalName, send }: { orgId: string; legalName: string | null; send?: Send }): ReactElement {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(legalName ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Set by Cancel: the trigger takes focus back after the render that brings it back. */
  const backToTrigger = useRef(false);
  const doSend: Send = send ?? ((body) => sendWrite<{ previousLegalName: string | null }>(`/api/admin/organisations/${encodeURIComponent(orgId)}`, 'PATCH', body, { onSlow: () => setStatus(L.saving) }));

  useEffect(() => {
    if (open) field.current?.focus();
    else if (backToTrigger.current) { backToTrigger.current = false; trigger.current?.focus(); }
  }, [open]);

  async function submit(): Promise<void> {
    if (busy) return;
    const refused = (message: string): void => {
      setError(message);
      setStatus(FIELD_MARKED);
      document.getElementById(`${formId}-legal-name`)?.focus();
    };
    const before = correctLegalNameError(value, legalName);
    if (before !== undefined) { refused(before); return; }
    setBusy(true);
    setStatus(L.saving);
    try {
      const r = await correctLegalName(value, legalName, doSend);
      if (r.kind === 'invalid') { refused(r.error); return; }
      setError(undefined);
      setStatus(r.status);
      if (r.saved || r.unchanged) {
        setOpen(false);
        router.refresh();
      }
      setTimeout(() => statusRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CorrectLegalNameView formId={formId} open={open} value={value} error={error} status={status} busy={busy} statusRef={statusRef}
      fieldRef={field} triggerRef={trigger}
      onOpen={() => setOpen(true)} onValue={setValue} onSubmit={() => { void submit(); }}
      onCancel={() => { const c = cancelledForm(legalName); backToTrigger.current = true; setOpen(c.open); setError(c.error); setValue(c.value); setStatus(c.status); }} />
  );
}
