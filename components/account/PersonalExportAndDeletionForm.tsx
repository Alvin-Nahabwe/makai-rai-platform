'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';
import { openDraftStore } from '@/lib/client/drafts';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { FieldError, FieldLabel, TextInput, describedBy } from '@/components/ui/TextInput';
import { PreparingDownload } from '@/components/export/PreparingDownload';
import { PERSONAL_DATA_COPY, phraseLabel } from '@/lib/account/copy';
import {
  DELETE_PHRASE, DELETION_UNCONFIRMED, NOT_DELETED, PLATFORM_ADMIN_ACCOUNT, lastActiveOwnerMessage as m38, tooManyAttempts,
} from '@/lib/export/messages';

/**
 * S-21's "My data" (FR-EXP-02, W-12 note 4) and "Delete my account" (FR-EXP-03, UX-29, W-12 note 5).
 * The export is a plain link to route 38. Deletion opens an inline confirmation with the current password
 * and the typed phrase, both pasteable and open to password managers, and sends DELETE /api/users/me
 * (route 39) as JSON. For a last owner with an active account the first button is replaced by M-38
 * naming each such organisation. Focus moves to the password on open, to a field the server refused, and
 * back to the first button on Cancel (UX-42).
 */

export const PREPARING_PERSONAL = PERSONAL_DATA_COPY.preparing;
const PHRASE_LABEL = phraseLabel(DELETE_PHRASE);

export type DeletionOutcome =
  | { kind: 'deleted' }
  | { kind: 'field'; field: 'password' | 'phrase'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'too_many'; message: string }
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'not_deleted'; message: string };

/**
 * What S-21 shows for route 39's answer (Routes row 39): 204, 422 on a field, 409 with its code, 429 with how long to
 * wait, a 5xx or a 401 as not known (the deletion commits organisation by organisation, so part of it may be done, and
 * a deletion that went through ends the session), and any other refusal as nothing deleted.
 */
export function deletionOutcome(status: number, body: unknown): DeletionOutcome {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown; organisation?: unknown; fields?: unknown; retryAfterSeconds?: unknown };
  if (status === 204) return { kind: 'deleted' };
  if (status === 422 && Array.isArray(b.fields)) {
    const f = b.fields[0] as { field?: unknown; message?: unknown } | undefined;
    if ((f?.field === 'password' || f?.field === 'phrase') && typeof f.message === 'string') return { kind: 'field', field: f.field, message: f.message };
  }
  if (status === 409 && b.code === 'last_active_owner' && typeof b.organisation === 'string') return { kind: 'refused', message: m38(b.organisation) };
  if (status === 409 && b.code === 'platform_admin_account') return { kind: 'refused', message: PLATFORM_ADMIN_ACCOUNT };
  if (status === 429) return { kind: 'too_many', message: tooManyAttempts(typeof b.retryAfterSeconds === 'number' ? b.retryAfterSeconds : null) };
  if (status >= 500 || status === 401) return { kind: 'unconfirmed', message: DELETION_UNCONFIRMED };
  return { kind: 'not_deleted', message: NOT_DELETED };
}

/** The inline confirmation of Delete my account (UX-29): password, typed phrase, and a button that repeats the action. */
export function DeleteConfirm({ userId, onCancel }: { userId: string; onCancel: () => void }): ReactElement {
  const id = useId();
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DeletionOutcome | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const phraseRef = useRef<HTMLInputElement>(null);

  useEffect(() => { passwordRef.current?.focus(); }, []);
  useEffect(() => {
    if (outcome?.kind === 'field') (outcome.field === 'password' ? passwordRef : phraseRef).current?.focus();
  }, [outcome]);

  async function onConfirm() {
    setBusy(true);
    let next: DeletionOutcome;
    try {
      const res = await fetch('/api/users/me', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, phrase }),
      });
      const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
      next = deletionOutcome(res.status, body);
    } catch {
      // fetch rejects only when no answer came back: the deletion may have run, in part or in full.
      next = { kind: 'unconfirmed', message: DELETION_UNCONFIRMED };
    }
    if (next.kind === 'deleted') {
      // Every session already ended on the server (sessionEpoch); this clears this browser's cookie and shows S-01.
      // The account's drafts (its reason text) leave this device first (NFR-PRIV-06).
      openDraftStore()?.purgeAccount(userId);
      try {
        await signOut({ callbackUrl: '/login' });
      } catch {
        window.location.assign('/login'); // the account is gone either way; a plain navigation finishes it
      }
      return;
    }
    setOutcome(next);
    setBusy(false);
  }

  const fieldError = (field: 'password' | 'phrase') => (outcome?.kind === 'field' && outcome.field === field ? outcome.message : null);
  const passwordError = fieldError('password');
  const phraseError = fieldError('phrase');
  const alertText = outcome !== null && outcome.kind !== 'deleted' && outcome.kind !== 'field' ? outcome.message : null;
  return (
    <InlineConfirm objectName={PERSONAL_DATA_COPY.objectName} consequence={PERSONAL_DATA_COPY.deleteConsequence} actionLabel={PERSONAL_DATA_COPY.deleteAction}
      onConfirm={onConfirm} onCancel={onCancel} busy={busy} canConfirm={password !== '' && phrase !== ''} destructive>
      <TextInput id={`${id}-password`} name="password" label={PERSONAL_DATA_COPY.passwordLabel} type="password" required autoComplete="current-password"
        ref={passwordRef} value={password} onChange={(e) => setPassword(e.currentTarget.value)} error={passwordError ?? undefined} />
      {/* TextInput has no autoCapitalize prop, so this one field is built from the kit's own field parts and class names. */}
      <div className="ui-field">
        <FieldLabel htmlFor={`${id}-phrase`} label={PHRASE_LABEL} required />
        <input ref={phraseRef} className={phraseError === null ? 'ui-input' : 'ui-input ui-input--invalid'} id={`${id}-phrase`} name="phrase" type="text"
          autoComplete="off" autoCapitalize="characters" spellCheck={false} required value={phrase} onChange={(e) => setPhrase(e.currentTarget.value)}
          aria-invalid={phraseError !== null} aria-describedby={describedBy(phraseError !== null && `${id}-phrase-error`)} />
        {phraseError === null ? null : <FieldError id={`${id}-phrase-error`} message={phraseError} />}
      </div>
      <StatusRegion message={alertText} politeness="assertive" tone="error" />
    </InlineConfirm>
  );
}

export function PersonalExportAndDeletionForm({ userId, lastActiveOwnerOf }: { userId: string; lastActiveOwnerOf: string[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closedOnce = useRef(false);
  useEffect(() => {
    if (!open && closedOnce.current) triggerRef.current?.focus();
  }, [open]);

  return (
    <>
      <section aria-labelledby="account-data-heading">
        <h2 id="account-data-heading">{PERSONAL_DATA_COPY.dataHeading}</h2>
        <p>{PERSONAL_DATA_COPY.downloadIntro}</p>
        <PreparingDownload href="/api/users/me/export" label={PERSONAL_DATA_COPY.download} preparing={PERSONAL_DATA_COPY.preparing} />
      </section>
      <section aria-labelledby="account-delete-heading">
        <h2 id="account-delete-heading">{PERSONAL_DATA_COPY.deleteHeading}</h2>
        {!open && <p>{PERSONAL_DATA_COPY.deleteConsequence}</p>}{/* once open, the confirmation says it (UX-29: object and consequence) */}
        {lastActiveOwnerOf.length > 0
          ? lastActiveOwnerOf.map((org) => <Callout key={org} kind="note">{m38(org)}</Callout>)
          : open
            ? <DeleteConfirm userId={userId} onCancel={() => { closedOnce.current = true; setOpen(false); }} />
            : <Button ref={triggerRef} variant="secondary" onClick={() => setOpen(true)}>{PERSONAL_DATA_COPY.deleteTrigger}</Button>}
      </section>
    </>
  );
}
