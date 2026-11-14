'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { sendWrite, type SendOutcome } from '@/lib/client/retrySafeWrite';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/TextInput';
import { MAX_ORG_NAME } from '@/lib/admin/limits';
import { ADMIN_FORMS_COPY } from '@/lib/admin/forms/copy';
import './AdminForms.css';

const N = ADMIN_FORMS_COPY.name;

type Send = (body: Record<string, unknown>) => Promise<SendOutcome<{ previousName: string }>>;

/** The field error for a new name, or undefined when it may be sent (C4 ORG-SF-4: an unchanged name is refused). */
export function correctNameError(value: string, current: string): string | undefined {
  const next = value.trim();
  if (next === '') return N.missing;
  if (next.length > MAX_ORG_NAME) return N.tooLong(MAX_ORG_NAME);
  if (next === current) return N.unchanged;
  return undefined;
}

/**
 * S-24's name change (FR-ORG-10; route 42). The earlier name is kept in the change's row on S-30, and documents
 * already issued keep the name they printed, which the result says.
 *
 * Focus (ruling L5-14): "Change the name" is replaced by the form, which opens on its field; Cancel gives focus back to
 * "Change the name". After a save, focus goes to the status line, which holds the result.
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
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** Set by Cancel: the trigger takes focus back after the render that brings it back. */
  const backToTrigger = useRef(false);
  const doSend: Send = send ?? ((body) => sendWrite<{ previousName: string }>(`/api/admin/organisations/${encodeURIComponent(orgId)}`, 'PATCH', body, { onSlow: () => setStatus(N.saving) }));

  useEffect(() => {
    if (open) field.current?.focus();
    else if (backToTrigger.current) { backToTrigger.current = false; trigger.current?.focus(); }
  }, [open]);

  async function submit(): Promise<void> {
    if (busy) return;
    const next = value.trim();
    const e = correctNameError(value, name);
    setError(e);
    if (e) { document.getElementById(`${formId}-name`)?.focus(); return; }
    setBusy(true);
    setStatus(N.saving);
    try {
      const out = await doSend({ name: next });
      if (out.kind === 'saved') {
        setStatus(N.saved(next, out.body.previousName));
        setOpen(false);
        router.refresh();
      } else if (out.kind === 'not_saved') {
        setStatus(N.lostReply);
      } else {
        setStatus(out.status === 401 ? N.signedOut : N.other);
      }
    } finally {
      setBusy(false);
      setTimeout(() => statusRef.current?.focus(), 0);
    }
  }

  return (
    <div className="admin-block">
      <div role="status" tabIndex={-1} ref={statusRef} className="ui-status">{status}</div>
      {!open ? (
        <Button ref={trigger} variant="secondary" onClick={() => setOpen(true)}>{N.change}</Button>
      ) : (
        <form method="post" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <TextInput ref={field} id={`${formId}-name`} name="name" label={N.label} error={error} required maxLength={MAX_ORG_NAME}
            autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="admin-form__actions">
            <Button variant="primary" type="submit" busy={busy}>{N.save}</Button>
            <Button variant="secondary" onClick={() => { backToTrigger.current = true; setOpen(false); setError(undefined); setValue(name); }}>{N.cancel}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
