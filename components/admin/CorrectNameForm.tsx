'use client';

import { useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { sendWrite, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { Field } from '@/components/admin/CreateOrganisationForm';
import { MAX_ORG_NAME } from '@/lib/admin/limits';

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<{ previousName: string }>>;

/** The field error for a corrected name, or undefined when it may be sent (C4 ORG-SF-4: an unchanged name is refused). */
export function correctNameError(value: string, current: string): string | undefined {
  const next = value.trim();
  if (next === '') return 'Enter the corrected name.';
  if (next.length > MAX_ORG_NAME) return `Use ${MAX_ORG_NAME} characters or fewer.`;
  if (next === current) return "This is already the organisation's name.";
  return undefined;
}

/**
 * S-24's name correction (FR-ORG-10; route 42). The earlier name is kept in the change's row on S-30, and documents
 * already issued keep the name they printed, which the result says.
 */
export function CorrectNameForm({ orgId, name, send }: { orgId: string; name: string; send?: Send }): ReactElement {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const doSend: Send = send ?? ((body) => sendWrite<{ previousName: string }>(`/api/admin/organisations/${encodeURIComponent(orgId)}`, 'PATCH', body, { onSlow: () => setStatus('Saving...') }));

  async function submit(): Promise<void> {
    if (busy) return;
    const next = value.trim();
    const e = correctNameError(value, name);
    setError(e);
    if (e) { document.getElementById(`${formId}-name`)?.focus(); return; }
    setBusy(true);
    setStatus('Saving...');
    try {
      const out = await doSend({ name: next });
      if (out.kind === 'saved') {
        setStatus(`Saved. The name is now ${next}; it was ${out.body.previousName}. Documents already issued keep the name they printed.`);
        setOpen(false);
        router.refresh();
      } else if (out.kind === 'not_saved') {
        setStatus('Not saved: connection lost. It may have arrived. Reload the page before trying again.');
      } else {
        setStatus(out.status === 401 ? 'Not saved: you have been signed out. Sign in again.' : 'Not saved. Reload the page and try again.');
      }
    } finally {
      setBusy(false);
      setTimeout(() => statusRef.current?.focus(), 0);
    }
  }

  return (
    <div>
      <div role="status" tabIndex={-1} ref={statusRef}>{status}</div>
      {!open ? (
        <button type="button" className="btn btn--secondary" onClick={() => setOpen(true)}>Correct the name</button>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field id={`${formId}-name`} label="Organisation name" error={error}>
            {(a) => <input id={a.id} name="name" type="text" required maxLength={MAX_ORG_NAME} autoComplete="off" value={value}
              aria-describedby={a.describedBy} aria-invalid={a.invalid} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" aria-disabled={busy || undefined}>Save the corrected name</button>
            <button type="button" className="btn btn--secondary" onClick={() => { setOpen(false); setError(undefined); setValue(name); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
