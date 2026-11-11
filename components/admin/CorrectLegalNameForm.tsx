'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { sendWrite, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { Field, MAX_LEGAL_NAME } from '@/components/admin/CreateOrganisationForm';

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<{ previousLegalName: string | null }>>;

const FIELD_MARKED = 'Not saved: check the field marked below.';

/** The field error for a corrected legal name, or undefined when it may be sent (an unchanged value is not sent, as for the name). */
export function correctLegalNameError(value: string, current: string | null): string | undefined {
  const next = value.trim();
  if (next === '') return 'Enter the institution\'s legal name.';
  if (next.length > MAX_LEGAL_NAME) return `Use ${MAX_LEGAL_NAME} characters or fewer.`;
  if (next === current) return 'This is already the institution\'s legal name.';
  return undefined;
}

/**
 * What came of correcting the legal name. `invalid` is a message for the input itself; `done` is a sentence for the
 * form's status region, `saved` telling whether the value was written. Only `{ legalName }` is ever sent: the parser's
 * "one at a time" error arrives on field `name`, so any 422 that does not name `legalName` is a form-level sentence.
 */
export async function correctLegalName(
  value: string, current: string | null, send: Send,
): Promise<{ kind: 'invalid'; error: string } | { kind: 'done'; status: string; saved: boolean }> {
  const error = correctLegalNameError(value, current);
  if (error !== undefined) return { kind: 'invalid', error };
  const next = value.trim();
  const out = await send({ legalName: next });
  if (out.kind === 'saved') {
    const was = out.body.previousLegalName === null ? 'none was recorded before' : `it was ${out.body.previousLegalName}`;
    return { kind: 'done', saved: true, status: `Saved. The legal name is now ${next}; ${was}.` };
  }
  if (out.kind === 'not_saved') return { kind: 'done', saved: false, status: 'Not saved: connection lost. It may have arrived. Reload the page before trying again.' };
  const fieldError = out.body.code === 'validation' ? out.body.fields?.find((f) => f.field === 'legalName') : undefined;
  if (fieldError !== undefined) return { kind: 'invalid', error: fieldError.message };
  return { kind: 'done', saved: false, status: out.status === 401 ? 'Not saved: you have been signed out. Sign in again.' : 'Not saved. Reload the page and try again.' };
}

export type CorrectLegalNameViewProps = {
  formId: string; open: boolean; value: string; error: string | undefined; status: string; busy: boolean;
  statusRef?: RefObject<HTMLDivElement | null>;
  onOpen: () => void; onValue: (v: string) => void; onSubmit: () => void; onCancel: () => void;
};

/**
 * The correction as markup. The status region is mounted from the first render, so the success and failure sentences
 * put in it are announced (4.1.3); the input has a visible label and its hint, tied by aria-describedby (the error,
 * when there is one, is tied the same way and the input takes focus).
 */
export function CorrectLegalNameView({ formId, open, value, error, status, busy, statusRef, onOpen, onValue, onSubmit, onCancel }: CorrectLegalNameViewProps): ReactElement {
  return (
    <div>
      <div role="status" tabIndex={-1} ref={statusRef}>{status}</div>
      {!open ? (
        <button type="button" className="btn btn--secondary" onClick={onOpen}>Correct the legal name</button>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          <Field id={`${formId}-legal-name`} label="Institution's legal name"
            hint="The registered name of the university, hospital or institute the team belongs to." error={error}>
            {(a) => <input id={a.id} name="legalName" type="text" required maxLength={MAX_LEGAL_NAME} autoComplete="off" value={value}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => onValue(e.target.value)} />}
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Save the corrected legal name</button>
            <button type="button" className="btn btn--secondary" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** S-24's legal-name correction (FR-ORG-10; route 42 with `{ legalName }`), beside the name correction. */
export function CorrectLegalNameForm({ orgId, legalName, send }: { orgId: string; legalName: string | null; send?: Send }): ReactElement {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(legalName ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const doSend: Send = send ?? ((body) => sendWrite<{ previousLegalName: string | null }>(`/api/admin/organisations/${encodeURIComponent(orgId)}`, 'PATCH', body, { onSlow: () => setStatus('Saving...') }));

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
    setStatus('Saving...');
    try {
      const r = await correctLegalName(value, legalName, doSend);
      if (r.kind === 'invalid') { refused(r.error); return; }
      setError(undefined);
      setStatus(r.status);
      if (r.saved) {
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
      onOpen={() => setOpen(true)} onValue={setValue} onSubmit={() => { void submit(); }}
      onCancel={() => { setOpen(false); setError(undefined); setValue(legalName ?? ''); }} />
  );
}
