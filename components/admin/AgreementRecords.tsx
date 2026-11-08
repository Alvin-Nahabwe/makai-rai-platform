'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { requestIdFor, sendWrite, type RetryState, type SendOutcome } from '@/lib/client/retrySafeWrite';
import {
  AgreementFields, EMPTY_AGREEMENT, agreementErrors, agreementInputOf, serverFieldErrors,
  type AgreementDraft, type AgreementVersionOption, type FieldErrors,
} from '@/components/admin/CreateOrganisationForm';
import { formatDay } from '@/lib/format/dates';
import type { AgreementView } from '@/types/api';
import type { CalendarDate } from '@/types/record';

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<AgreementView>>;

/**
 * S-24's agreement records (FR-ORG-05, FR-ORG-06; W-10 note 4). The records are read-only, newest first, the first
 * marked Current; "Record a newer agreement version" opens a form that adds a record (route 43) and never edits one,
 * with a request id kept for the same body, so a retry after a lost reply does not record it twice (NFR-INT-02).
 * An organisation with none says so in W-10's words and offers "Record its agreement".
 */
export function AgreementRecords({ orgId, agreements, versions, today, send }: {
  orgId: string; agreements: AgreementView[]; versions: readonly AgreementVersionOption[]; today: CalendarDate; send?: Send;
}): ReactElement {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AgreementDraft>(EMPTY_AGREEMENT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  // One request id per agreement body until it is recorded, so a retry after a lost reply is answered, not recorded twice.
  const retry = useRef<RetryState>({ requestId: null, sentBody: null });
  const doSend: Send = send ?? ((body) => sendWrite<AgreementView>(`/api/admin/organisations/${encodeURIComponent(orgId)}/agreements`, 'POST', body, { onSlow: () => setStatus('Recording...') }));

  async function submit(): Promise<void> {
    if (busy) return;
    const e = agreementErrors(draft, today, versions);
    setErrors(e);
    if (Object.keys(e).length > 0) {
      document.getElementById(`${formId}-agreement-${Object.keys(e)[0] === 'controllerLegalName' ? 'controller' : Object.keys(e)[0] === 'dpContactEmail' ? 'dpo' : Object.keys(e)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setStatus('Recording...');
    try {
      const body = { ...agreementInputOf(draft, versions) };
      const { requestId, state } = requestIdFor(retry.current, body);
      retry.current = state;
      const out = await doSend({ ...body, requestId });
      if (out.kind === 'saved') {
        retry.current = { requestId: null, sentBody: null };
        setStatus(`Recorded: agreement version ${out.body.agreementVersion} is now current.`);
        setOpen(false);
        setDraft(EMPTY_AGREEMENT);
        router.refresh();
      } else if (out.kind === 'not_saved') {
        setStatus('Not recorded: connection lost. It may have arrived. Reload the page before trying again.');
      } else if (out.body.code === 'validation') {
        setErrors(serverFieldErrors(out.body.fields));
        setStatus('Not recorded: check the fields marked below.');
      } else {
        setStatus(out.status === 401 ? 'Not recorded: you have been signed out. Sign in again.' : 'Not recorded. Reload the page and try again.');
      }
    } finally {
      setBusy(false);
      setTimeout(() => statusRef.current?.focus(), 0);
    }
  }

  return (
    <section aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`}>Agreement records</h2>
      <div role="status" tabIndex={-1} ref={statusRef}>{status}</div>
      {agreements.length === 0 ? (
        <p>No agreement recorded. This organisation was created before agreements were recorded. It keeps working.</p>
      ) : (
        <ul>
          {agreements.map((a, i) => (
            <li key={a.id}>
              {`v${a.agreementVersion} · accepted ${formatDay(a.acceptedOn)} · controller ${a.controllerLegalName} · ${a.dpContactEmail} · recorded on ${formatDay(a.recordedAt, 'Africa/Kampala')}`}
              {i === 0 ? <strong> · Current</strong> : null}
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button type="button" className="btn btn--secondary" onClick={() => setOpen(true)}>
          {agreements.length === 0 ? 'Record its agreement' : 'Record a newer agreement version'}
        </button>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <AgreementFields prefix={`${formId}-agreement`} draft={draft} errors={errors} versions={versions} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Record agreement</button>
            <button type="button" className="btn btn--secondary" onClick={() => { setOpen(false); setErrors({}); }}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
